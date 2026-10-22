import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { boot, type Harness, pastGrace, REPO, waitMatch } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

test("managed conversation survives closing and reopening the terminal UI", async () => {
  const root = mkdtempSync("/tmp/pituitary-managed-");
  const cwd = join(root, "managed");
  const state = join(root, "state");
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
    PITUITARY_STATE_DIR: state,
    PITUITARY_RUN_NAME: "managed",
    PI_AGENT_ARGS_JSON: "[]",
    PITUITARY_LOG: join(root, "tui.log"),
  };
  // The Bun host owns its worker; the Node PTY harness interacts through the public Runtime API.
  const driver = join(root, "runtime-fixture.ts");
  writeFileSync(
    driver,
    `
    import { Runtime } from ${JSON.stringify(pathToFileURL(join(REPO, "packages/harness/src/runtime.ts")).href)};
    import { startRuntime } from ${JSON.stringify(pathToFileURL(join(REPO, "packages/harness/src/supervisor.ts")).href)};
    const stateDirectory = ${JSON.stringify(state)};
    const host = await startRuntime({stateDirectory, workerCommand: [process.execPath,
      ${JSON.stringify(join(REPO, "packages/harness/src/worker.ts"))}, "--session", ${JSON.stringify(file)}]});
    const runtime = new Runtime({stateDirectory, autoStart:false});
    const run = await runtime.start({name:"managed",cwd:${JSON.stringify(cwd)}});
    const current = async () => {
      const detail = await runtime.inspect(run.id);
      const task = detail.tasks.find(item => item.id === detail.run.rootTaskId);
      return detail.attempts.find(item => item.id === task.currentAttemptId);
    };
    const stop = async () => {
      await runtime.stop(run.id);
      const deadline = Date.now() + 10000;
      while ((await current()).status !== "stopped") {
        if (Date.now() > deadline) throw new Error("Managed fixture stop timed out");
        await new Promise(resolve => setTimeout(resolve,25));
      }
    };
    let closing;
    const close = () => closing ??= stop().then(() => host.close());
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", input => {
      if (input.trim() === "archive") void stop().then(() => console.log(JSON.stringify({archived:true})));
    });
    process.once("SIGTERM", () => { void close().then(() => process.exit(0), error => {console.error(error);process.exit(1);}); });
    const deadline = Date.now() + 10000;
    while ((await current()).status !== "ready") {
      if (Date.now() > deadline) {await close();throw new Error("Managed fixture startup timed out");}
      await new Promise(resolve => setTimeout(resolve,25));
    }
    console.log(JSON.stringify({runId:run.id,directory:(await current()).directory}));
  `,
  );
  const host = spawn("bun", [driver], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  host.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => host.once("close", () => resolve()));
  const ready = new Promise<{ runId: string; directory: string }>((resolve, reject) => {
    let output = "";
    host.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(output.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    host.once("error", reject);
    host.once("exit", (code) => reject(new Error(`runtime fixture exited ${code}: ${errors}`)));
  });
  let app: Harness | undefined;
  try {
    const managed = await ready;
    const identityPath = join(managed.directory, "worker.json");
    const identity = readFileSync(identityPath, "utf8");
    const launch = (ready = "The worker kept this reply") =>
      boot({
        entry: join(REPO, "packages/tui/src/main.tsx"),
        cwd,
        ready,
        env: { ...environment, PITUITARY_RUN_ID: managed.runId },
      });
    app = await launch();
    assert.match(await app.capture("managed-attached"), /The worker kept this reply/);
    await app.terminal.write("\x04");
    await app.terminal.waitExit({ timeout: 10_000 });
    await app.close();
    app = undefined;
    assert.equal(host.exitCode, null, "detaching stopped the runtime");
    assert.equal(readFileSync(identityPath, "utf8"), identity);
    app = await launch();
    assert.match(
      await app.capture("managed-reconnected"),
      /The worker kept this reply across frontend restarts/,
    );
    await app.close();
    app = undefined;
    const archived = new Promise<void>((resolve, reject) => {
      let output = "";
      host.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('"archived":true')) resolve();
      });
      host.once("exit", () => reject(new Error(`runtime exited before archiving: ${errors}`)));
    });
    host.stdin.write("archive\n");
    await archived;
    app = await launch("Archived · read only");
    const archiveScreen = await app.capture("managed-archived");
    assert.match(archiveScreen, /The worker kept this reply across frontend restarts/);
    assert.match(archiveScreen, /Archived · read only/);
    assert.doesNotMatch(archiveScreen, /ask pi · !cmd/);
    await app.terminal.write("must not become a prompt\r\x1b[Z");
    assert.doesNotMatch(await app.terminal.text(), /must not become a prompt/);
    assert.equal(readFileSync(identityPath, "utf8"), identity);
    await app.terminal.write("/");
    await waitMatch(app.terminal, /archived conversation/);
    const commands = await app.capture("managed-archived-commands");
    assert.match(commands, /\/copy/);
    assert.match(commands, /\/session/);
    assert.doesNotMatch(commands, /\/model|\/compact|\/settings/);
    await pastGrace();
    await app.terminal.write("\x1b");
    await waitMatch(app.terminal, /^(?![\s\S]*archived conversation)/);
    await app.terminal.write("\x04");
    await app.terminal.waitExit({ timeout: 10_000 });
  } finally {
    try {
      await app?.close();
    } finally {
      host.kill("SIGTERM");
      const killer = setTimeout(() => host.kill("SIGKILL"), 15_000);
      try {
        await exited;
      } finally {
        clearTimeout(killer);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
