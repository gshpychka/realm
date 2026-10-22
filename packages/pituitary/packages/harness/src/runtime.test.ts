import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootAttempt, waitRun } from "./runtime.fixture.ts";
import { Runtime, type RuntimeOptions } from "./runtime.ts";
import { startRuntime } from "./supervisor.ts";

async function fixture(options: Partial<RuntimeOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pituitary-runtime-"));
  const configured = {
    stateDirectory: root,
    workerEnvironment: {
      PITUITARY_AUTH_FILE: join(root, "credentials", "auth.json"),
      PITUITARY_CONFIG_DIRECTORY: join(root, "configuration"),
    },
    ...options,
  };
  let host = await startRuntime(configured);
  const runtime = new Runtime({ ...configured, autoStart: false });
  return {
    root,
    runtime,
    reconnect: () => new Runtime({ stateDirectory: root, autoStart: false }),
    async restartHost() {
      await host.close();
      host = await startRuntime(configured);
    },
    async close() {
      try {
        for (const run of await runtime.list()) await runtime.stop(run.id);
        for (const run of await runtime.list())
          await waitRun(runtime, run.id, (detail) =>
            detail.attempts.every((attempt) => ["stopped", "failed"].includes(attempt.status)),
          );
      } finally {
        runtime.close();
        try {
          await host.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  };
}

test("native worker survives runtime and frontend disconnection, then stops explicitly", async () => {
  const environment = await fixture();
  let runtime = environment.runtime;
  try {
    const run = await runtime.start({ name: "durable-solo", cwd: environment.root });
    const ready = rootAttempt(
      await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready"),
    );
    expect(ready.sessionId).toBeTruthy();
    runtime.close();

    const first = await environment.reconnect().attach(run.id);
    const original = first.identity;
    await first.close();
    const second = await environment.reconnect().attach(run.id);
    expect(second.identity.incarnation).toBe(original.incarnation);
    expect((await second.getState()).sessionId).toBe(ready.sessionId as string);
    await second.close();

    await environment.restartHost();
    runtime = environment.reconnect();
    const recovered = rootAttempt(
      await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready"),
    );
    expect(recovered.sessionId).toBe(ready.sessionId);
    expect(recovered.incarnation).toBe(original.incarnation);
    expect((await runtime.stop(run.id)).desired).toBe("stopped");
    const stopped = await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
    expect((await runtime.stop(run.id)).desired).toBe("stopped");
    expect(
      stopped.events
        .filter((event) =>
          ["run_created", "worker_ready", "stop_requested", "worker_stopped"].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual(["run_created", "worker_ready", "worker_ready", "stop_requested", "worker_stopped"]);
  } finally {
    await environment.close();
  }
}, 20_000);

test("a failed executable leaves an inspectable attempt and no repeated launch", async () => {
  const environment = await fixture({
    workerCommand: ["/nonexistent/pituitary-worker"],
    startupTimeout: 1000,
  });
  try {
    const run = await environment.runtime.start({ name: "failed-worker", cwd: environment.root });
    const failed = await waitRun(
      environment.runtime,
      run.id,
      (detail) => rootAttempt(detail).status === "failed",
    );
    expect(rootAttempt(failed).error).toContain("ENOENT");
    expect(await environment.runtime.list()).toHaveLength(1);
    const again = await environment.runtime.inspect(run.id);
    expect(rootAttempt(again)).toEqual(rootAttempt(failed));
    expect(again.events.filter((event) => event.type === "attempt_interrupted")).toHaveLength(1);
  } finally {
    await environment.close();
  }
});

test("startup filesystem failures leave an inspectable attempt with a useful journal", async () => {
  const environment = await fixture();
  try {
    writeFileSync(join(environment.root, "runs"), "not a directory");
    const run = await environment.runtime.start({ name: "blocked-state", cwd: environment.root });
    const failed = await waitRun(
      environment.runtime,
      run.id,
      (detail) => rootAttempt(detail).status === "failed",
    );
    expect(rootAttempt(failed).error).toContain("ENOTDIR");
    expect(failed.events.map((event) => event.type)).toContain("attempt_interrupted");
    expect(failed.events.find((event) => event.type === "attempt_interrupted")?.data.error).toContain(
      "ENOTDIR",
    );
  } finally {
    await environment.close();
  }
});

test("a stalled handshake respects its deadline and cannot leave an unready child alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-stalled-fixture-"));
  const script = join(root, "stalled-worker.ts");
  writeFileSync(
    script,
    `
    import { createServer } from "node:net";
    process.on("SIGTERM", () => {});
    createServer(socket => socket.on("error", () => {}))
      .listen(process.argv[process.argv.indexOf("--socket") + 1]);
  `,
  );
  const environment = await fixture({ workerCommand: [process.execPath, script], startupTimeout: 150 });
  try {
    const started = Date.now();
    const run = await environment.runtime.start({ name: "stalled-worker", cwd: environment.root });
    const failed = rootAttempt(
      await waitRun(environment.runtime, run.id, (detail) => rootAttempt(detail).status === "failed", 2500),
    );
    expect(Date.now() - started).toBeLessThan(2500);
    expect(failed.error).toContain("timed out");
    expect(failed.pid).toBeTruthy();
    expect(() => process.kill(failed.pid as number, 0)).toThrow();
  } finally {
    await environment.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

test("a launch completing after stop cannot revive a cancelled task", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-delayed-fixture-"));
  const script = join(root, "delayed-worker.ts");
  const worker = new URL("./worker.ts", import.meta.url).href;
  writeFileSync(
    script,
    `
    await new Promise(resolve => setTimeout(resolve, 200));
    const { startWorker } = await import(${JSON.stringify(worker)});
    const args = process.argv.slice(2);
    const argument = flag => args[args.indexOf(flag) + 1];
    const worker = await startWorker({socketPath:argument("--socket"),stateDirectory:argument("--state"),cwd:argument("--cwd")});
    process.on("SIGTERM", () => { void worker.close().then(() => process.exit(0)); });
  `,
  );
  const environment = await fixture({ workerCommand: [process.execPath, script] });
  try {
    const run = await environment.runtime.start({ name: "stopped-during-launch", cwd: environment.root });
    await waitRun(environment.runtime, run.id, (detail) => rootAttempt(detail).status === "starting");
    await environment.runtime.stop(run.id);
    const stopped = await waitRun(
      environment.runtime,
      run.id,
      (detail) => rootAttempt(detail).status === "stopped",
    );
    expect(stopped.run.desired).toBe("stopped");
    expect(stopped.tasks[0]?.status).toBe("cancelled");
    expect(rootAttempt(stopped).desired).toBe("stopped");
    const final = await environment.runtime.inspect(run.id);
    expect(rootAttempt(final).status).toBe("stopped");
    expect(final.events.filter((event) => event.type === "worker_ready")).toEqual([]);
    expect(final.events.at(-1)?.type).toBe("worker_stopped");
  } finally {
    await environment.close();
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
