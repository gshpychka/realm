import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { launch, press } from "./helpers/harness.ts";

const DOWN = "\x1b[B";
const ESC = "\x1b";

after(async () => {
  await closeAll();
});

/** Stores a session begun in `cwd` with one exchange, at `file`. */
function storeSession(file: string, cwd: string, question: string): void {
  const dir = join(file, "..", ".store");
  mkdirSync(dir, { recursive: true });
  const manager = SessionManager.create(cwd, dir);
  manager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `the answer to ${question}` }],
    api: "anthropic-messages",
    provider: "fake",
    model: "fake-model-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const stored = manager.getSessionFile();
  if (!stored) throw new Error("the session was not stored");
  renameSync(stored, file);
}

const cwdOf = (file: string) =>
  (JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "") as { cwd: string }).cwd;

test("/import asks first, then opens a copy of the file beside the current session", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (home, sessions, cwd) => {
      storeSession(join(home, "shared", "notes.jsonl"), cwd, "rate limits");
      // A session of the same name already stored, so the copy takes the next free name.
      storeSession(join(sessions, "notes.jsonl"), cwd, "an older question");
    },
  });
  await app.terminal.submit("/import ~/shared/notes.jsonl");
  await app.terminal.waitText("replace the current session with ~/shared/notes.jsonl?");
  const asked = await app.capture("import-confirm");
  assert.match(asked, /▸ replace it/, asked);
  await app.terminal.submit();
  await app.terminal.waitText("the answer to rate limits");
  const screen = await app.capture("imported");
  assert.match(screen, /imported the session from ~\/shared\/notes\.jsonl/, screen);
  const sessions = join(app.home, "sessions");
  assert.ok(existsSync(join(sessions, "notes-1.jsonl")), readdirSync(sessions).join("\n"));
  assert.ok(existsSync(join(app.home, "shared", "notes.jsonl")));
  await app.close();
});

test("/import keeps the current session when the operator says so", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (home, _sessions, cwd) => storeSession(join(home, "shared", "notes.jsonl"), cwd, "rate limits"),
  });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/import ~/shared/notes.jsonl");
  await app.terminal.waitText("replace the current session with");
  await press(app.terminal, DOWN, "▸ keep the current session");
  await app.terminal.submit();
  await app.terminal.waitText("import cancelled");
  const screen = await app.terminal.text();
  assert.match(screen, /You said: first/, screen);
  assert.equal(existsSync(join(app.home, "sessions", "notes.jsonl")), false);
  await app.close();
});

test("/import keeps the current session when the operator closes the confirmation", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (home, _sessions, cwd) => storeSession(join(home, "shared", "notes.jsonl"), cwd, "rate limits"),
  });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/import ~/shared/notes.jsonl");
  await app.terminal.waitText("replace the current session with");
  await press(app.terminal, ESC, "import cancelled");
  const screen = await app.capture("import-closed");
  assert.match(screen, /You said: first/, screen);
  assert.doesNotMatch(screen, /replace the current session with/, screen);
  assert.deepEqual(
    readdirSync(join(app.home, "sessions")).filter((name) => name.startsWith("notes")),
    [],
  );
  await app.close();
});

test("/import of a session whose directory is gone continues in this one", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (home) => storeSession(join(home, "shared", "notes.jsonl"), join(home, "gone"), "rate limits"),
  });
  await app.terminal.submit("/import ~/shared/notes.jsonl");
  await app.terminal.waitText("replace the current session with");
  await app.terminal.submit();
  await app.terminal.waitText("the session's directory ~/gone does not exist");
  const asked = await app.capture("import-missing-cwd");
  assert.match(asked, /▸ continue in ~\/projects\/work\/sample/, asked);
  await app.terminal.submit();
  await app.terminal.waitText("the answer to rate limits");
  assert.equal(cwdOf(join(app.home, "sessions", "notes.jsonl")), app.cwd);
  assert.equal(cwdOf(join(app.home, "shared", "notes.jsonl")), join(app.home, "gone"));
  await app.close();
});

test("/import says how to use it without a path, and when the file is missing", async () => {
  const app = await launch({ scenario: "hello" });
  // A command whose argument is required completes on the first enter and runs on the second.
  await app.terminal.submit("/import");
  await app.terminal.submit();
  await app.terminal.waitText("/import: usage: /import <path.jsonl>");
  await app.terminal.submit("/import ~/nowhere.jsonl");
  await app.terminal.waitText("/import: no session file at ~/nowhere.jsonl");
  await app.capture("import-missing");
  await app.close();
});
