import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch } from "./helpers/harness.ts";

const CTRL_O = "\x0f";

after(async () => {
  await closeAll();
});

test("renders a tool call with its output and final state", async () => {
  const app = await launch({ scenario: "tool" });
  await app.terminal.submit("what is here");
  await app.terminal.waitText("Three entries");
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("justfile");
  const screen = await app.capture("tool");
  assert.match(screen, /✓ \$ ls -1/, `tool header missing:\n${screen}`);
  assert.match(screen, /justfile/, `tool output missing:\n${screen}`);
  assert.match(screen, /Three entries at the root/, `follow-up answer missing:\n${screen}`);
  await app.close();
});

test("marks a failed tool call", async () => {
  const app = await launch({ scenario: "tool-error" });
  await app.terminal.submit("run false");
  await app.terminal.waitText("The command failed");
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("exit status 1");
  const screen = await app.capture("tool-error");
  assert.match(screen, /✗ \$ false/, `error state missing:\n${screen}`);
  await app.close();
});

test("shows thinking separately from the answer", async () => {
  const app = await launch({ scenario: "thinking" });
  await app.terminal.submit("think about it");
  await app.terminal.waitText("Here is the answer");
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("Weighing");
  const screen = await app.capture("thinking");
  assert.match(screen, /Weighing the options carefully/, `thinking missing:\n${screen}`);
  await app.close();
});
