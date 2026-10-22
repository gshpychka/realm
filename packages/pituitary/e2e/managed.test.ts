import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { boot, type Harness, REPO } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

/** An observer can stop the local worker without competing for the UI's input lease. */
async function shutdown(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("worker shutdown timed out"));
    }, 5000);
    let pending = "";
    let finished = false;
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ type: "hello", version: 1, control: false })}\n`),
    );
    socket.on("error", reject);
    socket.on("data", (data: Buffer) => {
      pending += data.toString();
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const record = JSON.parse(pending.slice(0, newline)) as {
          type: string;
          success?: boolean;
          error?: string;
        };
        pending = pending.slice(newline + 1);
        if (record.type === "welcome")
          socket.write(
            `${JSON.stringify({ type: "command", id: "test-shutdown", command: { type: "shutdown" } })}\n`,
          );
        if (record.type === "result") {
          finished = true;
          clearTimeout(timer);
          socket.destroy();
          if (record.success) resolve();
          else reject(new Error(record.error));
        }
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!finished) reject(new Error("worker closed before acknowledging shutdown"));
    });
  });
}

test("managed conversation survives closing and reopening the terminal UI", async () => {
  const root = mkdtempSync("/tmp/pituitary-managed-");
  const cwd = join(root, "managed");
  const state = join(root, "state");
  const socket = join(root, "worker.sock");
  mkdirSync(cwd);
  mkdirSync(state, { mode: 0o700 });
  const session = SessionManager.create(cwd, join(state, "sessions"));
  session.appendMessage({
    role: "user",
    content: "Keep this conversation while the terminal is closed.",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The worker kept this reply across frontend restarts." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = session.getSessionFile();
  assert.ok(file);
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    PITUITARY_AUTH_FILE: join(root, "auth.json"),
    PITUITARY_CONFIG_DIRECTORY: join(root, "config"),
    PITUITARY_GH: "",
    PITUITARY_STILL: "1",
    PITUITARY_WORKER_SOCKET: socket,
    PITUITARY_RUN_NAME: "managed",
    PI_AGENT_ARGS_JSON: "[]",
    PITUITARY_LOG: join(root, "tui.log"),
  };
  const worker = spawn(
    "bun",
    [
      join(REPO, "packages/harness/src/worker.ts"),
      "--socket",
      socket,
      "--state",
      state,
      "--cwd",
      cwd,
      "--session",
      file,
    ],
    {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  worker.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  let app: Harness | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(socket)) {
      if (worker.exitCode !== null) throw new Error(`worker failed: ${errors}`);
      if (Date.now() > deadline) throw new Error(`worker startup timed out: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const identity = readFileSync(join(state, "worker.json"), "utf8");
    const launch = () =>
      boot({
        entry: join(REPO, "packages/tui/src/main.tsx"),
        cwd,
        ready: "The worker kept this reply",
        env: environment,
      });
    app = await launch();
    assert.match(await app.capture("managed-attached"), /The worker kept this reply/);
    await app.terminal.write("\x04");
    await app.terminal.waitExit({ timeout: 10_000 });
    await app.close();
    app = undefined;
    assert.equal(worker.exitCode, null, "detaching stopped the worker");
    assert.equal(readFileSync(join(state, "worker.json"), "utf8"), identity);
    app = await launch();
    assert.match(
      await app.capture("managed-reconnected"),
      /The worker kept this reply across frontend restarts/,
    );
  } finally {
    await app?.close();
    await shutdown(socket).catch(() => worker.kill("SIGTERM"));
    const killer = setTimeout(() => worker.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(killer);
    rmSync(root, { recursive: true, force: true });
  }
});
