import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { rootAttempt, waitRun } from "./runtime.fixture.ts";
import { Runtime, runtimeSocket } from "./runtime.ts";
import { startRuntime } from "./supervisor.ts";

async function fixture() {
  const root = mkdtempSync("/tmp/pituitary-host-"),
    faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  const options = { stateDirectory: root, models, environment: { PITUITARY_MODEL: "faux/faux-1" } };
  let host = await startRuntime(options);
  const client = () => new Runtime({ stateDirectory: root, autoStart: false });
  return {
    root,
    faux,
    options,
    client,
    async restart() {
      await host.close();
      host = await startRuntime(options);
    },
    async close() {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Native conversation did not settle");
    await new Promise((done) => setTimeout(done, 20));
  }
}

test("frontend detach and host restart retain the same native conversation without another worker", async () => {
  const f = await fixture();
  try {
    const runtime = f.client(),
      run = await runtime.start({ name: "durable", cwd: f.root });
    const ready = await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready");
    const first = await runtime.attach(run.id),
      conversation = (await first.getState()).sessionId;
    f.faux.setResponses([fauxAssistantMessage("Retained native answer.")]);
    await first.prompt("Keep this answer");
    await until(async () => JSON.stringify(await first.getMessages()).includes("Retained native answer."));
    await first.close();
    await f.restart();
    const second = await f.client().attach(run.id);
    expect((await second.getState()).sessionId).toBe(conversation);
    expect(JSON.stringify(await second.getMessages())).toContain("Retained native answer.");
    expect(rootAttempt(await runtime.inspect(run.id)).id).toBe(rootAttempt(ready).id);
    expect(f.faux.state.callCount).toBe(1);
    await second.close();
    await runtime.stop(run.id);
    const stopped = await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
    expect(stopped.run.desired).toBe("stopped");
    const archive = await runtime.attach(run.id);
    expect(archive.identity.archived).toBe(true);
    expect(archive.controlsInput).toBe(false);
    expect(JSON.stringify(await archive.getMessages())).toContain("Retained native answer.");
    await archive.close();
  } finally {
    await f.close();
  }
}, 30000);

test("one input lease coexists with observers and cancellation revokes an already open view", async () => {
  const f = await fixture();
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root });
    await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready");
    const writer = await runtime.attach(run.id),
      observer = await runtime.connect(run.id, false);
    expect(writer.controlsInput).toBe(true);
    expect(observer.controlsInput).toBe(false);
    await expect(runtime.attach(run.id)).rejects.toThrow("input lease");
    await expect(observer.prompt("not allowed")).rejects.toThrow("input authority");
    await runtime.stop(run.id);
    await expect(writer.prompt("too late")).rejects.toThrow("input authority");
    await writer.close();
    await observer.close();
  } finally {
    await f.close();
  }
}, 30000);

test("native recovery resumes an interrupted generation without resubmitting its input", async () => {
  const f = await fixture();
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root });
    await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready");
    const view = await runtime.attach(run.id),
      sessionId = (await view.getState()).sessionId;
    f.faux.setResponses([
      async (_context, options) => {
        await new Promise<void>((done) => {
          if (options?.signal?.aborted) done();
          else options?.signal?.addEventListener("abort", () => done(), { once: true });
        });
        return fauxAssistantMessage("Interrupted output", { stopReason: "aborted" });
      },
      fauxAssistantMessage("Recovered from the native checkpoint."),
    ]);
    await view.prompt("Continue this exact input");
    await until(async () => f.faux.state.callCount === 1);
    await f.restart();
    await view.close();
    const resumed = await runtime.attach(run.id);
    expect((await resumed.getState()).sessionId).toBe(sessionId);
    await until(async () =>
      JSON.stringify(await resumed.getMessages()).includes("Recovered from the native checkpoint."),
    );
    const messages = await resumed.getMessages();
    expect(
      messages.filter(
        (message) =>
          !!message &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "user" &&
          JSON.stringify(message).includes("Continue this exact input"),
      ),
    ).toHaveLength(1);
    expect(f.faux.state.callCount).toBe(2);
    await resumed.close();
  } finally {
    await f.close();
  }
}, 30000);

test("a second host cannot open the same native storage while its socket owner is alive", async () => {
  const f = await fixture();
  try {
    await expect(startRuntime(f.options)).rejects.toThrow("already owns");
    expect(await f.client().list()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("an explicit remote socket never starts a local daemon", async () => {
  const root = mkdtempSync("/tmp/pituitary-tunnel-"),
    socket = join(root, "tunnel.sock");
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/v1/status" ? '{"ready":true}' : "[]");
  });
  await new Promise<void>((done) => server.listen(socket, done));
  try {
    expect(await new Runtime({ stateDirectory: join(root, "uncreated"), socketPath: socket }).list()).toEqual(
      [],
    );
    expect(calls).toEqual(["/v1/status", "/v1/runs"]);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("cold attachment waits for the native conversation created by a new run", async () => {
  const f = await fixture();
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root });
    const view = await runtime.attach(run.id);
    expect(view.identity.runId).toBe(run.id);
    expect(view.controlsInput).toBe(true);
    await view.close();
  } finally {
    await f.close();
  }
}, 30000);

test("state-directory aliases cannot start a second socket owner for the same database", async () => {
  const f = await fixture(),
    alias = mkdtempSync("/tmp/pituitary-alias-");
  try {
    symlinkSync(dirname(f.root), join(alias, "parent"));
    const state = join(alias, "parent", basename(f.root));
    expect(runtimeSocket(state)).toBe(runtimeSocket(f.root));
    await expect(startRuntime({ ...f.options, stateDirectory: state })).rejects.toThrow("already owns");
    expect(await f.client().list()).toEqual([]);
  } finally {
    await f.close();
    rmSync(alias, { recursive: true, force: true });
  }
});

test("removing a live socket does not bypass the native database's process lock", async () => {
  const f = await fixture();
  try {
    rmSync(runtimeSocket(f.root));
    await expect(startRuntime(f.options)).rejects.toThrow(/locked|busy/i);
    await f.restart();
    expect(await f.client().list()).toEqual([]);
  } finally {
    await f.close();
  }
}, 30000);

test("clients wait through startup 503 and can retry a rejected readiness check", async () => {
  const root = mkdtempSync("/tmp/pituitary-startup-"),
    socket = join(root, "runtime.sock");
  let mode: "opening" | "rejected" | "ready" = "rejected",
    remaining = 2;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/v1/status") {
      res.end("[]");
      return;
    }
    if (mode === "rejected") {
      res.writeHead(400).end('{"error":"temporarily refused"}');
      return;
    }
    if (mode === "opening" && remaining-- > 0) {
      res.writeHead(503).end('{"ready":false}');
      return;
    }
    res.end('{"ready":true}');
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const client = new Runtime({
      stateDirectory: join(root, "uncreated"),
      socketPath: socket,
      autoStart: false,
      startupTimeout: 2000,
    });
    await expect(client.list()).rejects.toThrow("temporarily refused");
    mode = "opening";
    expect(await client.list()).toEqual([]);
    expect(remaining).toBeLessThanOrEqual(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent observers reserve their bounded attachment slots before opening snapshots", async () => {
  const f = await fixture();
  const views: Array<Awaited<ReturnType<Runtime["connect"]>>> = [];
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 33 }, () => runtime.connect(run.id, false)),
    );
    for (const outcome of outcomes) if (outcome.status === "fulfilled") views.push(outcome.value);
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(views).toHaveLength(32);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain("Too many conversation views");
  } finally {
    await Promise.allSettled(views.map((view) => view.close()));
    await f.close();
  }
}, 30000);
