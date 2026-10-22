import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSessionState } from "@pituitary/rpc";
import { Runtime } from "./runtime.ts";
import { startWorker } from "./worker.ts";
import { connectWorker } from "./worker-client.ts";

test("native worker survives runtime and frontend disconnection, then stops explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-"));
  const options = {
    stateDirectory: root,
    workerEnvironment: {
      PITUITARY_AUTH_FILE: join(root, "credentials", "auth.json"),
      PITUITARY_CONFIG_DIRECTORY: join(root, "configuration"),
    },
  };
  let runtime: Runtime | null = new Runtime(options);
  let name: string | undefined;
  try {
    const run = await runtime.start({ name: "durable-solo", cwd: root });
    name = run.name;
    expect(run.status).toBe("ready");
    expect(run.sessionId).toBeTruthy();
    runtime.close();
    runtime = null;

    const first = await connectWorker(run.socket);
    const original = first.identity;
    await first.close();
    const second = await connectWorker(run.socket);
    expect(second.identity.incarnation).toBe(original.incarnation);
    expect((await second.getState()).sessionId).toBe(run.sessionId as string);
    await second.close();

    runtime = new Runtime(options);
    expect((await runtime.inspect(name)).sessionId).toBe(run.sessionId);
    expect((await runtime.stop(name)).status).toBe("stopped");
    expect((await runtime.stop(name)).status).toBe("stopped");
    expect(runtime.store.events(run.id).map((event) => event.type)).toEqual([
      "run_created",
      "worker_starting",
      "worker_ready",
      "stop_requested",
      "worker_stopped",
    ]);
  } finally {
    if (name) {
      runtime ??= new Runtime(options);
      await runtime.stop(name).catch(() => {});
    }
    runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a failed executable leaves an inspectable run and no repeated launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-failed-"));
  const runtime = new Runtime({
    stateDirectory: root,
    workerCommand: ["/nonexistent/pituitary-worker"],
    startupTimeout: 1000,
  });
  try {
    await expect(runtime.start({ name: "failed-worker", cwd: root })).rejects.toThrow("Could not start");
    expect(runtime.store.get("failed-worker").status).toBe("failed");
    expect((await runtime.inspect("failed-worker")).status).toBe("failed");
    expect(runtime.store.list()).toHaveLength(1);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup filesystem failures leave a failed run with a useful journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-filesystem-"));
  const runtime = new Runtime({ stateDirectory: root });
  try {
    writeFileSync(join(root, "runs"), "not a directory");
    await expect(runtime.start({ name: "blocked-state", cwd: root })).rejects.toThrow("Could not start");
    const run = runtime.store.get("blocked-state");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("ENOTDIR");
    expect(runtime.store.events(run.id).map((event) => event.type)).toEqual(["run_created", "start_failed"]);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stalled handshake respects the startup deadline and cannot leave an unready worker alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-stalled-"));
  const fixture = join(root, "stalled-worker.ts");
  writeFileSync(
    fixture,
    `
    import { createServer } from "node:net";
    process.on("SIGTERM", () => {});
    createServer(socket => socket.on("error", () => {}))
      .listen(process.argv[process.argv.indexOf("--socket") + 1]);
  `,
  );
  const runtime = new Runtime({
    stateDirectory: root,
    workerCommand: [process.execPath, fixture],
    startupTimeout: 150,
  });
  try {
    const started = Date.now();
    await expect(runtime.start({ name: "stalled-worker", cwd: root })).rejects.toThrow("Could not start");
    expect(Date.now() - started).toBeLessThan(2500);
    const run = runtime.store.get("stalled-worker");
    expect(run.status).toBe("failed");
    expect(run.pid).toBeTruthy();
    expect(() => process.kill(run.pid as number, 0)).toThrow();
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

test("an observation begun before stop cannot revive the stopped run", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-observation-"));
  const runtime = new Runtime({ stateDirectory: root });
  const run = runtime.store.create({ name: "stopped-during-inspect", cwd: root });
  let hold = false;
  let answer: (() => void) | undefined;
  const state = { ...fakeSessionState, sessionId: "observation-session" };
  const worker = await startWorker({
    socketPath: run.socket,
    stateDirectory: run.directory,
    cwd: root,
    engineFactory: async () => ({
      call: async (command) => {
        if (command.type !== "get_state") return undefined;
        if (hold)
          return new Promise((resolve) => {
            answer = () => resolve(state);
          });
        return state;
      },
      respond: () => {},
      close: async () => {},
    }),
  });
  try {
    runtime.store.update(run.id, { status: "ready", sessionId: state.sessionId }, "worker_ready");
    hold = true;
    const inspection = runtime.inspect(run.id);
    for (let step = 0; !answer && step < 100; step++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(answer).toBeDefined();
    runtime.store.update(run.id, { status: "stopped" }, "worker_stopped");
    answer?.();
    expect((await inspection).status).toBe("stopped");
    expect(runtime.store.events(run.id).at(-1)?.type).toBe("worker_stopped");
  } finally {
    hold = false;
    answer?.();
    await worker.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid worker command does not create runtime state", () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-invalid-"));
  const stateDirectory = join(root, "unused");
  try {
    expect(() => new Runtime({ stateDirectory, workerCommand: [] })).toThrow("must not be empty");
    expect(existsSync(stateDirectory)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
