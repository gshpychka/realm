import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { boot, type Harness, pastGrace, REPO, waitMatch } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});
test("managed UI reload, host restart and archive preserve one native conversation", async () => {
  const root = mkdtempSync("/tmp/pituitary-managed-");
  const cwd = join(root, "workspace"),
    state = join(root, "state");
  mkdirSync(cwd);
  mkdirSync(state, { mode: 0o700 });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    PITUITARY_GH: "",
    PITUITARY_STILL: "1",
    PITUITARY_STATE_DIR: state,
    PITUITARY_RUN_NAME: "managed",
    PITUITARY_LOG: join(root, "tui.log"),
    PITUITARY_UI_STATE: join(root, "frontend.json"),
  };
  const host = spawn("bun", [join(REPO, "packages/harness/src/managed-runtime.fixture.ts"), state, cwd], {
    env: {
      PATH: process.env.PATH,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      TMPDIR: process.env.TMPDIR,
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "",
    output = "";
  host.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Set<() => void>();
  host.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const lines = output.split("\n");
    output = lines.pop() ?? "";
    for (const line of lines) {
      messages.push(JSON.parse(line));
      for (const listener of listeners) listener();
    }
  });
  const exited = new Promise<void>((resolve) => host.once("close", () => resolve()));
  const message = (predicate: (item: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Runtime fixture did not reply: ${errors}`));
      }, 20000);
      const check = () => {
        const found = messages.find(predicate);
        if (found) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found);
        }
      };
      listeners.add(check);
      host.once("exit", (code) => {
        clearTimeout(timer);
        listeners.delete(check);
        reject(new Error(`Runtime fixture exited ${code}: ${errors}`));
      });
      check();
    });
  let app: Harness | undefined;
  try {
    const ready = await message((item) => typeof item.runId === "string");
    const launch = (text = "The host kept this reply", resume = false, plain = false) =>
      boot({
        entry: join(REPO, "packages/tui/src/main.tsx"),
        cwd,
        ready: text,
        env: {
          ...environment,
          PITUITARY_RUN_ID: String(ready.runId),
          ...(resume ? { PITUITARY_UI_RESUME: "1" } : {}),
          ...(plain ? { PITUITARY_NVIM: "/nonexistent/nvim" } : {}),
        },
      });
    app = await launch();
    assert.match(await app.capture("managed-attached"), /The host kept this reply/);
    await app.terminal.type("Keep my draft across frontend reload");
    await app.terminal.waitText("Keep my draft across frontend reload");
    await app.terminal.write("\x12");
    await app.terminal.waitExit({ timeout: 10000 });
    await app.close();
    app = undefined;
    assert.equal(host.exitCode, null, "frontend reload stopped the host");
    const saved = JSON.parse(readFileSync(environment.PITUITARY_UI_STATE, "utf8"));
    assert.match(JSON.stringify(saved.views), /Keep my draft across frontend reload/);
    app = await launch("Keep my draft across frontend reload", true, true);
    assert.match(await app.capture("managed-ui-reloaded"), /The host kept this reply/);
    await app.terminal.type(" with edits");
    await app.terminal.resize(100, 12);
    await app.terminal.waitText("Keep my draft across frontend reload with edits");
    assert.match(await app.capture("managed-draft-resized"), /reload with edits/);
    await app.close();
    app = undefined;
    host.stdin.write("restart\n");
    const restarted = await message((item) => item.restarted === true);
    assert.equal(restarted.conversationId, ready.conversationId);
    assert.equal(restarted.modelCalls, 1);
    app = await launch();
    assert.match(
      await app.capture("managed-reconnected"),
      /The host kept this reply across frontend and runtime restarts/,
    );
    await app.close();
    app = undefined;
    host.stdin.write("archive\n");
    const archived = await message((item) => item.archived === true);
    assert.equal(archived.conversationId, ready.conversationId);
    app = await launch("Archived · read only");
    const screen = await app.capture("managed-archived");
    assert.match(screen, /The host kept this reply/);
    assert.doesNotMatch(screen, /ask pi · !cmd/);
    await app.terminal.write("must not become a prompt\r");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.capture("managed-archived-input-rejected"), /must not become a prompt/);
    await app.terminal.write("/");
    await app.terminal.waitText("archived conversation");
    const commands = await app.capture("managed-archived-commands");
    assert.match(commands, /\/copy/);
    assert.doesNotMatch(commands, /\/model|\/compact|\/settings/);
    await pastGrace();
    await app.terminal.keyboard.press("Escape");
    await waitMatch(app.terminal, /^(?![\s\S]*archived conversation)/);
    await app.terminal.write("\x04");
    await app.terminal.waitExit({ timeout: 10000 });
  } finally {
    try {
      await app?.close();
    } finally {
      host.kill("SIGTERM");
      const killer = setTimeout(() => host.kill("SIGKILL"), 15000);
      try {
        await exited;
      } finally {
        clearTimeout(killer);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
});
