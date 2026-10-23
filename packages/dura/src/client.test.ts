import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Runtime, runtimeSocket } from "./client.ts";
import { rootAttempt, waitRun } from "./runtime.fixture.ts";
import { startRuntime } from "./supervisor.ts";

async function fixture() {
  const root = mkdtempSync("/tmp/dura-host-"),
    faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  const options = { stateDirectory: root, models, environment: { DURA_MODEL: "faux/faux-1" } };
  let host = await startRuntime(options);
  const client = () => new Runtime({ stateDirectory: root });
  return {
    root,
    faux,
    options,
    client,
    async restart() {
      await host.close();
      host = await startRuntime(options);
    },
    closeHost: () => host.close(),
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

test("a client never creates host state or bootstraps a detached runtime", async () => {
  const root = mkdtempSync("/tmp/dura-client-"),
    stateDirectory = join(root, "absent");
  try {
    const runtime = new Runtime({ stateDirectory });
    await expect(runtime.list()).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(stateDirectory)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    await until(async () => !writer.controlsInput);
    await expect(writer.prompt("too late")).rejects.toThrow("task changed");
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

test("a cached runtime revalidates after a lost connection without replaying uncertain commands", async () => {
  const root = mkdtempSync("/tmp/dura-reconnect-"),
    socketPath = join(root, "runtime.sock");
  let status = 0,
    reads = 0,
    disconnect = false;
  const server = createServer((req, res) => {
    if (req.url === "/v1/status") {
      status++;
      res.end('{"ready":true}');
      return;
    }
    reads++;
    if (disconnect) {
      disconnect = false;
      req.socket.destroy();
      return;
    }
    res.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const runtime = new Runtime({ stateDirectory: root, socketPath });
    expect(await runtime.list()).toEqual([]);
    disconnect = true;
    await expect(runtime.list()).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(reads).toBe(2);
    expect(await runtime.list()).toEqual([]);
    expect(status).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("frontend handoff waits for an old input lease's admitted command to drain", async () => {
  const f = await fixture();
  let release!: () => void, aborted!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    aborting = new Promise<void>((resolve) => {
      aborted = resolve;
    });
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root }),
      writer = await runtime.attach(run.id);
    f.faux.setResponses([
      async (_context, options) => {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true },
          ),
        );
        await gate;
        return fauxAssistantMessage("Stopped", { stopReason: "aborted" });
      },
    ]);
    await writer.prompt("Wait for cancellation");
    await until(async () => f.faux.state.callCount === 1);
    const active = writer.abort().catch(() => {});
    await aborting;
    await writer.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const takeover = runtime.attach(run.id);
    void takeover.catch(() => {});
    release();
    const next = await takeover;
    expect(next.controlsInput).toBe(true);
    await next.close();
    await active;
  } finally {
    release();
    await f.close();
  }
}, 30_000);

test("graceful host shutdown drains an admitted stop before closing its storage", async () => {
  const f = await fixture();
  let release!: () => void, aborted!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    aborting = new Promise<void>((resolve) => {
      aborted = resolve;
    });
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root }),
      view = await runtime.attach(run.id);
    f.faux.setResponses([
      async (_context, options) => {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true },
          ),
        );
        await gate;
        return fauxAssistantMessage("Stopped", { stopReason: "aborted" });
      },
    ]);
    await view.prompt("Work until stopped");
    await until(async () => f.faux.state.callCount === 1);
    const stopping = runtime.stop(run.id);
    await aborting;
    const closing = f.closeHost();
    release();
    expect((await stopping).desired).toBe("stopped");
    await closing;
    await f.restart();
    expect((await runtime.inspect(run.id)).run.desired).toBe("stopped");
    await view.close();
  } finally {
    release();
    await f.close();
  }
}, 30_000);

test("an explicit remote socket never starts a local daemon", async () => {
  const root = mkdtempSync("/tmp/dura-tunnel-"),
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

test("socket discovery is deterministic without creating host directories", () => {
  const root = mkdtempSync("/tmp/dura-discovery-"),
    absent = join(root, "absent");
  try {
    expect(runtimeSocket(absent)).toBe(runtimeSocket(join(absent, ".")));
    expect(runtimeSocket(absent)).not.toBe(runtimeSocket(root));
    expect(existsSync(absent)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  const root = mkdtempSync("/tmp/dura-startup-"),
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

test("an opening host that disappears returns to availability instead of waiting out startup", async () => {
  const root = mkdtempSync("/tmp/dura-opening-loss-"),
    socketPath = join(root, "runtime.sock");
  const server = createServer((_req, response) => {
    response.writeHead(503).end('{"ready":false}');
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = new Runtime({ stateDirectory: root, socketPath, startupTimeout: 2000 });
    await expect(client.list()).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("native host commands admit image payloads larger than one MiB", async () => {
  const f = await fixture();
  try {
    const runtime = f.client(),
      run = await runtime.start({ cwd: f.root }),
      view = await runtime.attach(run.id);
    const data = Buffer.alloc(1024 * 1024).toString("base64");
    f.faux.setResponses([
      (context) => {
        const message = context.messages.findLast((entry) => entry.role === "user");
        expect(message?.content).toContainEqual({ type: "image", mimeType: "image/png", data });
        return fauxAssistantMessage("Image input received.");
      },
    ]);
    await view.call({
      type: "prompt",
      message: "Read this image",
      images: [{ type: "image", mimeType: "image/png", data }],
    });
    await until(async () => JSON.stringify(await view.getMessages()).includes("Image input received."));
    expect(f.faux.state.callCount).toBe(1);
    await view.close();
  } finally {
    await f.close();
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
