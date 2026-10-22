import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { COLS, launch, ROWS } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

after(async () => {
  await closeAll();
});

test("/debug writes the screen, the session state, and the messages beside pi's own log", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/debug");
  await app.terminal.waitText("wrote the debug log to ~/.pi/agent/pituitary-debug.log");
  await app.capture("debug");
  const path = join(app.home, ".pi", "agent", "pituitary-debug.log");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const log = readFileSync(path, "utf8");
  assert.match(log, re.m`^Terminal: ${COLS}x${ROWS}$`, log);
  const screen = log.slice(log.indexOf("=== Screen ==="), log.indexOf("=== Session state ==="));
  assert.equal(screen.match(/^\[\d+\] /gm)?.length, ROWS, screen);
  assert.match(screen, /You said: first/, screen);
  assert.match(log, /"sessionId": "fake-session"/, log);
  const messages = log
    .slice(log.indexOf("=== Agent messages (JSONL) ==="))
    .split("\n")
    .slice(1)
    .filter(Boolean);
  assert.equal(messages.length, 2, log);
  assert.equal((JSON.parse(messages[0] ?? "") as { content: string }).content, "first");
  await app.close();
});
