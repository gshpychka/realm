import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

after(async () => {
  await closeAll();
});

test("a resumed session opens on its history", async () => {
  const app = await launch({ scenario: "resumed" });
  await app.terminal.waitText("Both bounds hold.");
  const screen = await app.capture("resumed");
  assert.match(
    screen,
    re`${glyphs.summary} \[compaction\] compacted from ${glyphs.tokens} 120,000 tokens · ctrl\+o`,
    screen,
  );
  assert.match(screen, /▌ cap the window at 168h/, screen);
  assert.match(screen, re`▸ ${glyphs.tool} 1 tool`, screen);
  assert.match(screen, /\[proposed-plan\]/, screen);
  assert.doesNotMatch(screen, /Ask pi something/, `placeholder over history:\n${screen}`);
  await app.close();
});

test("a new prompt continues after the history", async () => {
  const app = await launch({ scenario: "resumed" });
  await app.terminal.waitText("Both bounds hold.");
  await app.terminal.submit("and the docs");
  await app.terminal.waitText("You said: and the docs");
  const screen = await app.capture("resumed-continued");
  assert.ok(screen.indexOf("Both bounds hold.") < screen.indexOf("You said"), screen);
  await app.close();
});

test("an extension message shows in the conversation as it arrives", async () => {
  const app = await launch({ scenario: "fresh" });
  await app.terminal.submit("plan it");
  await app.terminal.waitText("1. do it");
  const screen = await app.capture("custom-message");
  assert.match(screen, /\[proposed-plan\]/, screen);
  await app.close();
});

test("a command that replaces the session brings the view along", async () => {
  const app = await launch({ scenario: "fresh" });
  await app.terminal.submit("plan it");
  await app.terminal.waitText("1. do it");
  await app.terminal.submit("/fresh");
  await app.terminal.waitText("Implementing.");
  const screen = await app.capture("session-replaced");
  assert.doesNotMatch(screen, /Planned\./, `old session still shown:\n${screen}`);
  assert.match(screen, /▌ implement the plan/, screen);
  await app.close();
});
