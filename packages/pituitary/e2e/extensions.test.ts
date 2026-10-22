import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, pastGrace, RUNNING, settled } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const DOWN = "\x1b[B";
const CTRL_S = "\x13";

after(async () => {
  await closeAll();
});

test("a permission prompt blocks the run until it is answered", async () => {
  const app = await launch({ scenario: "permission" });
  await app.terminal.submit("clean up");
  await app.terminal.waitText("rm -rf build");
  await pastGrace();
  const asked = await app.capture("dialog-select");
  assert.match(asked, /Yes, for this session/, asked);
  assert.match(asked, /waiting on you · \d+s/, `run settled before the answer:\n${asked}`);
  await app.terminal.write(DOWN);
  await app.terminal.write(DOWN);
  await app.terminal.submit();
  await app.terminal.waitText("Left build alone (No)");
  const answered = await app.capture("dialog-select-answered");
  assert.doesNotMatch(answered, /Yes, for this session/, `dialog stayed open:\n${answered}`);
  await settled(app.terminal);
  await app.close();
});

test("escape cancels a dialog without aborting the run", async () => {
  const app = await launch({ scenario: "permission" });
  await app.terminal.submit("clean up");
  await app.terminal.waitText("rm -rf build");
  await pastGrace();
  await app.terminal.keyboard.press("Escape");
  await app.terminal.waitText("Left build alone ((cancelled))");
  const screen = await app.capture("dialog-cancelled");
  assert.doesNotMatch(screen, re`${glyphs.info} aborted`, `escape aborted the run:\n${screen}`);
  await app.close();
});

test("confirm, input, and editor dialogs each carry their answer back", async () => {
  const app = await launch({ scenario: "dialogs" });
  await app.terminal.submit("start");
  await app.terminal.waitText("Replace notes.md?");
  await pastGrace();
  await app.capture("dialog-confirm");
  await app.terminal.type("y");
  await app.terminal.waitText("Name the branch");
  await pastGrace();
  await app.terminal.submit("feat/limits");
  await app.terminal.waitText("Describe the change");
  await pastGrace();
  await app.capture("dialog-editor");
  await app.terminal.type("upper bound");
  await app.terminal.write(CTRL_S);
  await app.terminal.waitText("confirm=yes");
  const screen = await app.capture("dialog-chain-answered");
  assert.match(screen, /branch=feat\/limits/, screen);
  assert.match(screen, /notes=Why: \/ upper bound/, screen);
  await app.close();
});

test("a dialog after the run settles is answered like any other", async () => {
  const app = await launch({ scenario: "ready" });
  await app.terminal.submit("plan it");
  await app.terminal.waitText("Plan ready");
  await pastGrace();
  const screen = await app.capture("dialog-unprompted");
  assert.doesNotMatch(screen, RUNNING, screen);
  await app.terminal.submit();
  await app.terminal.waitText("chose: Implement it");
  await app.close();
});

test("statuses, widgets, notices, and editor text from extensions are shown", async () => {
  const app = await launch({ scenario: "display" });
  await app.terminal.submit("go");
  await app.terminal.waitText("Display set.");
  const screen = await app.capture("display");
  assert.ok(screen.includes(glyphs.mcp), `statuses missing:\n${screen}`);
  assert.doesNotMatch(screen, /checkpoints|mcp 2\/2/, `status words left in:\n${screen}`);
  // Every MCP server is connected, which the icon's quiet colour says in place of the count.
  const footer = await app.terminal.cells(0, 26, 100, 2);
  assert.equal(footer.find((cell) => cell.char === glyphs.mcp)?.fg, "#7c6f64");
  assert.doesNotMatch(screen, /\[33m/, `escape codes leaked:\n${screen}`);
  assert.match(screen, /plan: 1\. read limits\.ts/, `widget missing:\n${screen}`);
  assert.match(screen, re`${glyphs.warning} lens: 2 diagnostics fixed`, `notice missing:\n${screen}`);
  assert.match(screen, /» implement the plan/, `editor text missing:\n${screen}`);
  await app.close();
});

test("the agent dying is reported", async () => {
  const app = await launch({ scenario: "crash" });
  await app.terminal.submit("go");
  await app.terminal.waitText("pi stopped");
  const screen = await app.capture("agent-stopped");
  assert.match(screen, /pi stopped · ctrl\+c twice to quit/, screen);
  assert.match(screen, /code=3/, screen);
  await app.close();
});
