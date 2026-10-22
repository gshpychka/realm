import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, pastGrace, settled, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

after(async () => {
  await closeAll();
});

/** The seconds the working line shows on `screen`. */
function seconds(screen: string): number {
  const match = / · (\d+)s · /.exec(screen);
  assert.ok(match, `no working line:\n${screen}`);
  return Number(match[1]);
}

test("the working line names what the run does, reading apart from thinking, and counts the tokens it generates", async () => {
  const app = await launch({ scenario: "phases", delayMs: 200 });
  await app.terminal.submit("clean up");

  await waitMatch(app.terminal, /reading · \d+s · esc esc interrupts *$/m, 10_000);
  const reading = await app.capture("working-reading");
  assert.match(reading, re.m`${glyphs.reading} reading · \d+s · esc esc interrupts *$`, reading);

  await waitMatch(app.terminal, re`thinking · \d+s · esc esc interrupts · ${glyphs.tokens} \d+`, 10_000);
  const thinking = await app.capture("working-thinking");
  assert.match(thinking, re`${glyphs.thinking} thinking · \d+s · esc esc interrupts · ${glyphs.tokens} \d+`);

  await waitMatch(app.terminal, /writing · \d+s/, 10_000);
  const writing = await app.capture("working-writing");
  assert.match(writing, re`${glyphs.writing} writing · \d+s · esc esc interrupts · ${glyphs.tokens} \d+`);

  await waitMatch(app.terminal, /bash · \d+s/, 10_000);
  const tool = await app.capture("working-tool");
  assert.match(tool, re`${glyphs.tool} bash · \d+s · esc esc interrupts · ${glyphs.tokens} 1\.2k`, tool);

  await waitMatch(app.terminal, re`reading · \d+s · esc esc interrupts · ${glyphs.tokens} 1\.2k`, 10_000);
  const read = await app.capture("working-reading-result");
  assert.match(
    read,
    re`${glyphs.reading} reading · \d+s · esc esc interrupts · ${glyphs.tokens} 1\.2k`,
    read,
  );
  assert.match(read, /│ +build +│\n *│ +flake\.nix/, `the tool's result is not yet on screen:\n${read}`);
  await app.close();
});

test("while a dialog waits on the operator the clock holds, and it resumes from there once answered", async () => {
  const app = await launch({ scenario: "phases", delayMs: 100 });
  await app.terminal.submit("clean up");
  await waitMatch(app.terminal, /waiting on you · \d+s/, 15_000);
  const asked = await app.capture("working-waiting");
  assert.match(asked, re`${glyphs.waiting} waiting on you · \d+s · ${glyphs.tokens} 1\.4k`, asked);
  assert.doesNotMatch(asked, /interrupts/, `the line offers a key the dialog takes:\n${asked}`);
  assert.match(asked, /rm -rf build/, asked);
  const held = seconds(asked);

  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const later = await app.capture("working-waiting-held");
  assert.equal(seconds(later), held, `the clock ran while the operator was waited on:\n${later}`);

  await pastGrace();
  await app.terminal.type("y");
  const resumed = await waitMatch(
    app.terminal,
    /(bash|reading|thinking|writing) · \d+s · esc esc interrupts/,
    10_000,
  );
  assert.ok(seconds(resumed) <= held + 1, `the wait counted toward the run:\n${resumed}`);
  await app.terminal.waitText("Cleared (yes).");
  await settled(app.terminal);
  await app.close();
});

test("a narrow terminal drops the token count first, and keeps the interrupt key whole", async () => {
  const app = await launch({ scenario: "phases", delayMs: 200, cols: 44 });
  await app.terminal.submit("clean up");
  await waitMatch(app.terminal, /bash · \d+s/, 10_000);
  const screen = await app.capture("working-narrow");
  assert.match(screen, /bash · \d+s · esc esc interrupts *$/m, screen);
  assert.ok(!screen.includes(glyphs.tokens), screen);
  await app.close();
});

test("a compaction in progress names itself beside its icon", async () => {
  const app = await launch({ scenario: "compacting" });
  await app.terminal.submit("go");
  await app.terminal.waitText("compacting ·");
  const screen = await app.capture("working-compacting");
  assert.match(screen, re`${glyphs.compacting} compacting · esc esc cancels`, screen);
  await app.close();
});
