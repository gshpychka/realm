import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, normalMode, pastGrace, settled, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

after(async () => {
  await closeAll();
});

/** A turn's summary line; the clock time it ended is whatever the clock read. */
const SUMMARY = re.m`^\s*${glyphs.turn} (?:\d+m )?\d+s · .*\d\d:\d\d`;

/** The rows of `screen` holding a turn's summary. */
function summaries(screen: string): string[] {
  return screen.split("\n").filter((line) => SUMMARY.test(line));
}

test("a turn that ran tools ends with the time it worked, less the operator's wait, its tokens, and its tool calls", async () => {
  const app = await launch({ scenario: "phases", delayMs: 100 });
  const began = Date.now();
  await app.terminal.submit("clean up");
  await waitMatch(app.terminal, /waiting on you · \d+s/, 15_000);
  const asked = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await pastGrace();
  const answered = Date.now();
  await app.terminal.type("y");
  await app.terminal.waitText("Cleared (yes).", { timeout: 10_000 });
  await settled(app.terminal);
  const screen = await waitMatch(app.terminal, SUMMARY);
  const ended = Date.now();
  await app.capture("turn-tools");

  const [line] = summaries(screen);
  assert.ok(line, screen);
  assert.match(line, re`${glyphs.turn} \d+s · ${glyphs.tokens} 1\.4k · 2 tools · \d\d:\d\d(?! ·)`, screen);
  const rows = screen.split("\n");
  assert.ok(
    rows.indexOf(line) > rows.findIndex((row) => row.includes("Cleared (yes).")),
    `the summary sits above the reply:\n${screen}`,
  );
  const worked = Number(/ (\d+)s · /.exec(line)?.[1]);
  const bound = Math.ceil((ended - began - (answered - asked)) / 1000) + 1;
  assert.ok(worked <= bound, `the wait counted toward the turn:\n${screen}`);
  await app.close();
});

test("an interrupted turn says so at the end of its summary", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await normalMode(app.terminal);
  await app.terminal.keyboard.press("Escape");
  await settled(app.terminal);
  const screen = await waitMatch(app.terminal, SUMMARY);
  await app.capture("turn-interrupted");
  assert.match(screen, re.m`${glyphs.turn} \d+s · ${glyphs.tokens} \d+ · \d\d:\d\d · interrupted`, screen);
  await app.close();
});

test("a turn without tools leaves the tool count out", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await settled(app.terminal);
  const screen = await waitMatch(app.terminal, SUMMARY);
  await app.capture("turn-plain");
  assert.match(screen, re.m`^\s*${glyphs.turn} \d+s · ${glyphs.tokens} 3 · \d\d:\d\d(?! ·)`, screen);
  assert.doesNotMatch(summaries(screen).join("\n"), /tool|interrupted|error/, screen);
  await app.close();
});

test("history the session held before has no summaries, and each live turn keeps its own", async () => {
  const app = await launch({ scenario: "resumed" });
  await app.terminal.waitText("Both bounds hold.");
  assert.deepEqual(summaries(await app.terminal.text()), []);
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await settled(app.terminal);
  await waitMatch(app.terminal, SUMMARY);
  await app.terminal.submit("second");
  await app.terminal.waitText("You said: second");
  await settled(app.terminal);
  const screen = await waitMatch(app.terminal, re.m`${SUMMARY}[\s\S]*${SUMMARY}`);
  await app.capture("turn-resumed");
  assert.equal(summaries(screen).length, 2, screen);
  await app.close();
});
