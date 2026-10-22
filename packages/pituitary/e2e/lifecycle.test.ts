import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { type Launched, launch, REPO, survivors, uiPid } from "./helpers/harness.ts";

const PROBE = join(REPO, "e2e/fixtures/probe.ts");

/** Terminal modes the UI turns on, each of which it must turn off again on the way out. */
const MODES = ["1049", "1000", "1002", "1003", "1006", "1004", "2004", "2031"];

after(async () => {
  await closeAll();
});

/** Saves a session with one exchange in `cwd`, so pi reports a session file that exists. */
function savedSession(cwd: string, sessions: string): string {
  const session = SessionManager.create(cwd, sessions);
  session.appendMessage({ role: "user", content: "cap the window at 168h", timestamp: Date.now() });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Both bounds hold now." }],
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
  if (!file) throw new Error("the session manager kept no file");
  return file;
}

/** Terminal modes still on, and whether the cursor is hidden, once the raw output ends. */
function leftOn(raw: string): string[] {
  const left: string[] = [];
  for (const mode of MODES) {
    const set = raw.lastIndexOf(`\x1b[?${mode}h`);
    if (set >= 0 && raw.lastIndexOf(`\x1b[?${mode}l`) < set) left.push(mode);
  }
  if (raw.lastIndexOf("\x1b[?25l") > raw.lastIndexOf("\x1b[?25h")) left.push("cursor hidden");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the kitty keyboard push starts with ESC
  const pushed = raw.match(/\x1b\[>\d*u/g)?.length ?? 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the kitty keyboard pop starts with ESC
  const popped = raw.match(/\x1b\[<\d*u/g)?.length ?? 0;
  if (pushed > popped) left.push("kitty keyboard");
  return left;
}

async function gone(home: string): Promise<string[]> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const left = survivors(home);
    if (left.length === 0 || Date.now() > deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const EXITS: Record<string, (app: Launched) => Promise<void>> = {
  "ctrl+d": (app) => app.terminal.write("\x04"),
  "ctrl+c twice": async (app) => {
    await app.terminal.write("\x03");
    await app.terminal.write("\x03");
  },
  SIGTERM: async (app) => {
    process.kill(uiPid(app.home), "SIGTERM");
  },
  SIGHUP: async (app) => {
    process.kill(uiPid(app.home), "SIGHUP");
  },
};

for (const [name, leave] of Object.entries(EXITS)) {
  test(`${name} leaves no process, socket, or terminal mode behind`, async () => {
    let file = "";
    const app = await launch({
      pi: ["--no-extensions", "-e", PROBE],
      argv: ["--continue"],
      prepare: (_home, sessions, cwd) => {
        file = savedSession(cwd, sessions);
      },
      record: true,
    });
    await app.terminal.waitText("Both bounds hold now.");
    await leave(app);
    await app.terminal.waitExit({ timeout: 10_000 });

    assert.deepEqual(await gone(app.home), [], "processes outlived the UI");
    assert.deepEqual(readdirSync(join(app.home, "run")), [], "the runtime directory kept files");
    const output = app.raw();
    assert.deepEqual(leftOn(output), [], "terminal modes left on");
    assert.ok(output.includes(`To resume this session: pituitary --session ${file}`), "resume hint missing");
    await app.close();
  });
}

test("a session pi never saved gets no resume hint", async () => {
  const app = await launch({ pi: ["--no-extensions", "-e", PROBE], record: true });
  await app.terminal.write("\x04");
  await app.terminal.waitExit({ timeout: 10_000 });
  assert.doesNotMatch(app.raw(), /To resume this session/);
  assert.deepEqual(await gone(app.home), []);
  await app.close();
});
