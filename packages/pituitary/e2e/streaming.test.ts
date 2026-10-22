import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, normalMode, RUNNING, settled } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

after(async () => {
  await closeAll();
});

test("reports the streaming phase and offers steering while the agent runs", async () => {
  const app = await launch({ scenario: "long", delayMs: 40 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  const screen = await app.capture("streaming");
  assert.match(screen, /writing · \d+s · esc esc interrupts/, `phase missing:\n${screen}`);
  assert.match(
    screen,
    re.m`^ ${glyphs.steering} queue a steering message`,
    `editor did not switch to steering:\n${screen}`,
  );
  await app.close();
});

test("queues a prompt typed during a run and reports the queue depth", async () => {
  const app = await launch({ scenario: "long", delayMs: 40 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("focus on error handling");
  await app.terminal.waitText(`${glyphs.steering} steering focus on error handling`);
  const screen = await app.capture("steering");
  assert.match(screen, /up edits queued messages/, `queue missing:\n${screen}`);
  await app.close();
});

test("escape aborts the run and the session settles", async () => {
  const app = await launch({ scenario: "long", delayMs: 60 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await normalMode(app.terminal);
  await app.terminal.keyboard.press("Escape");
  await settled(app.terminal);
  const screen = await app.capture("aborted");
  assert.doesNotMatch(screen, RUNNING, `did not settle:\n${screen}`);
  assert.match(screen, /aborted/, `abort notice missing:\n${screen}`);
  await app.close();
});

test("keeps the newest output visible in a long answer", async () => {
  const app = await launch({ scenario: "long" });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 40 of the long answer");
  const screen = await app.capture("long");
  assert.match(screen, /line 40 of the long answer/, `tail not visible:\n${screen}`);
  assert.doesNotMatch(screen, /line 1 of the long answer\b/, `view did not scroll:\n${screen}`);
  await app.close();
});
