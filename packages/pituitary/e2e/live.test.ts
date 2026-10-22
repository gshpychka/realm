import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, pastGrace, REPO } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const PROBE = join(REPO, "e2e/fixtures/probe.ts");
const DOWN = "\x1b[B";

after(async () => {
  await closeAll();
});

test("real pi's extension dialogs are answered through the UI", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", PROBE] });
  await app.terminal.submit("/probe");
  await app.terminal.waitText("Pick a colour");
  await pastGrace();
  const asked = await app.capture("live-select");
  assert.match(asked, /probe live/, `status missing:\n${asked}`);
  assert.match(asked, /probe widget line/, `widget missing:\n${asked}`);
  await app.terminal.write(DOWN);
  await app.terminal.submit();
  await app.terminal.waitText("picked teal");
  await pastGrace();
  await app.terminal.type("y");
  await app.terminal.waitText("Name it");
  await pastGrace();
  await app.terminal.submit("ember");
  await app.terminal.waitText("probe: teal true ember");
  await app.capture("live-answered");
  await app.close();
});

test("real pi counts a custom message the way the view counts it", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", PROBE] });
  await app.terminal.submit("/probe");
  await app.terminal.waitText("Pick a colour");
  await pastGrace();
  await app.terminal.submit();
  await app.terminal.waitText("picked amber");
  await pastGrace();
  await app.terminal.type("n");
  await app.terminal.waitText("Name it");
  await pastGrace();
  await app.terminal.submit("x");
  await app.terminal.waitText("probe: amber false x");
  await app.terminal.submit("/note");
  await app.terminal.waitText("probe note");
  // A resync rebuilds the view from the messages pi holds, which drops the notice.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const screen = await app.capture("live-custom");
  assert.match(screen, /\[probe\]/, screen);
  assert.match(screen, re`${glyphs.info} probe: amber false x`, `view was rebuilt:\n${screen}`);
  await app.close();
});

test("real pi runs a ! command and records it the way the view counts it", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", PROBE] });
  await app.terminal.submit("/probe");
  await app.terminal.waitText("Pick a colour");
  await pastGrace();
  await app.terminal.submit();
  await app.terminal.waitText("picked amber");
  await pastGrace();
  await app.terminal.type("y");
  await app.terminal.waitText("Name it");
  await pastGrace();
  await app.terminal.submit("z");
  await app.terminal.waitText("probe: amber true z");
  await app.terminal.submit("!printf 'one\\ntwo\\n'");
  await app.terminal.waitText("two");
  await app.terminal.submit("/note");
  await app.terminal.waitText("probe note");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const screen = await app.capture("live-bash");
  assert.match(screen, /one\n\s*two/, screen);
  assert.match(screen, re`${glyphs.info} probe: amber true z`, `view was rebuilt:\n${screen}`);
  await app.close();
});

test("real pi's extension commands complete, and /name reaches the footer", async () => {
  const app = await launch({ pi: ["--no-extensions", "-e", PROBE] });
  await app.terminal.type("/pro");
  await app.terminal.waitText("Ask through every dialog");
  await app.terminal.keyboard.press("Escape");
  await app.terminal.write("\x15");
  await app.terminal.submit("/name live check");
  await app.terminal.waitText(`${glyphs.session} live check`);
  await app.capture("live-name");
  await app.close();
});

// pi writes a session file only once it holds a reply, which takes a model, so the earlier
// session is written directly.
test("real pi's sessions resume through the picker", async () => {
  const app = await launch({
    pi: ["--no-extensions", "-e", PROBE],
    prepare: (_home, sessions, cwd) => {
      const earlier = SessionManager.create(cwd, sessions);
      earlier.appendSessionInfo("earlier work");
      earlier.appendMessage({ role: "user", content: "cap the window at 168h", timestamp: Date.now() });
      earlier.appendMessage({
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
    },
  });
  await app.terminal.submit("/resume");
  await app.terminal.waitText("earlier work");
  await app.terminal.submit();
  await app.terminal.waitText("Both bounds hold now.");
  const screen = await app.capture("live-resumed");
  assert.match(screen, /▌ cap the window at 168h/, screen);
  assert.ok(screen.includes(`${glyphs.session} earlier work`), screen);
  await app.close();
});
