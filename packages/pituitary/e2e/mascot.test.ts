import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { type Box, bounds, fireCells } from "./helpers/fire.ts";
import { launch, RUNNING, settled, waitMatch } from "./helpers/harness.ts";

const WIDE = 140;
const ROWS = 28;

/** Too narrow for the footer's narrowest hearth beside the budget and the model. */
const NARROW = 30;

/**
 * Wider than the fire's hearth in the corner and its five columns beside the working line, and
 * narrower than the screen between the two; as tall as its two rows beside the working line.
 */
const FIRE_COLUMNS = 24;
const FIRE_ROWS = 2;

after(async () => {
  await closeAll();
});

/** True when every fire cell fits one fire's shape, so the screen shows one fire at most. */
const single = (box: Box | null) =>
  box === null || (box.right - box.left < FIRE_COLUMNS && box.bottom - box.top < FIRE_ROWS);

const describe = (box: Box | null) => (box ? `${box.left},${box.top} to ${box.right},${box.bottom}` : "none");

async function fire(terminal: TuiTest, cols = WIDE): Promise<Box | null> {
  return bounds(await fireCells(terminal, cols, ROWS));
}

/**
 * Waits for the terminal to finish drawing the frame in flight: the harness reads the
 * screen as it arrives, where a terminal shows a synchronized frame whole.
 */
const drawn = () => new Promise((resolve) => setTimeout(resolve, 150));

/** The row the working line's words are on, or -1. */
async function workingRow(terminal: TuiTest): Promise<number> {
  return (await terminal.text()).split("\n").findIndex((line) => RUNNING.test(line));
}

test("while pi works the one fire burns beside the working line, and the corner is empty", async () => {
  const app = await launch({ scenario: "long", delayMs: 80, cols: WIDE });
  await app.terminal.waitText("fake-model-1");
  assert.equal((await fire(app.terminal))?.bottom, ROWS - 1, "no fire in the corner while idle");
  await app.terminal.submit("go");
  await waitMatch(app.terminal, RUNNING);
  await drawn();
  const screen = await app.capture("mascot-working");
  const box = await fire(app.terminal);
  const row = await workingRow(app.terminal);
  assert.ok(box && single(box), `not one fire: ${describe(box)}\n${screen}`);
  assert.equal(box.bottom, row, `the fire is not beside the working line: ${describe(box)}\n${screen}`);
  assert.ok(box.left <= 6, `the fire is not at the start of the working line: ${describe(box)}`);
  assert.match(screen.split("\n")[row] ?? "", / · \d+s · esc esc interrupts/, screen);
  await app.close();
});

test("the fire travels between the corner and the working line and back, never doubling and never gone", async () => {
  const app = await launch({
    scenario: "long",
    delayMs: 60,
    cols: WIDE,
    settle: false,
    env: { PITUITARY_STILL: "0" },
  });
  await app.terminal.waitText("fake-model-1");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await app.capture("mascot-idle");
  const start = performance.now();
  await app.terminal.submit("go");
  const seen: string[] = [];
  let working = false;
  let captured = false;
  let returned = false;
  while (performance.now() - start < 8000) {
    let box = await fire(app.terminal);
    let row = await workingRow(app.terminal);
    const at = Math.round(performance.now() - start);
    // A reading taken while a frame is still arriving can hold parts of two; the next one decides.
    if (!single(box) || (row >= 0 && !box)) {
      await drawn();
      box = await fire(app.terminal);
      row = await workingRow(app.terminal);
    }
    seen.push(`${at} ${describe(box)}`);
    assert.ok(single(box), `two fires at ${at} ms: ${describe(box)}`);
    if (row >= 0) {
      working = true;
      assert.ok(box, `no fire at ${at} ms while pi works`);
    }
    if (!captured && at > 150) {
      await app.capture("mascot-travelling");
      captured = true;
    }
    if (working && row < 0 && box?.bottom === ROWS - 1 && box.left > WIDE / 2) {
      returned = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  assert.ok(working, "the run never showed");
  assert.ok(returned, `the fire never came back to the corner:\n${seen.join("\n")}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await app.capture("mascot-idle-again");
  await app.close();
});

test("without room in the corner the fire appears only while pi works", async () => {
  const app = await launch({ scenario: "long", delayMs: 80, cols: NARROW });
  await app.terminal.waitText("fake-model-1");
  assert.equal(await fire(app.terminal, NARROW), null, "a fire burned in a corner without room");
  await app.terminal.submit("go");
  await waitMatch(app.terminal, RUNNING);
  await drawn();
  const box = await fire(app.terminal, NARROW);
  assert.ok(box && single(box), `not one fire at the working line: ${describe(box)}`);
  assert.equal(box.bottom, await workingRow(app.terminal));
  await settled(app.terminal);
  await app.terminal.waitText("line 40");
  assert.equal(await fire(app.terminal, NARROW), null, "the fire stayed after the run");
  await app.close();
});

test("a fire held still takes its place and shape and does not move", async () => {
  const app = await launch({ scenario: "long", delayMs: 80, cols: WIDE });
  await app.terminal.submit("go");
  await waitMatch(app.terminal, RUNNING);
  await drawn();
  const first = await fireCells(app.terminal, WIDE, ROWS);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await fireCells(app.terminal, WIDE, ROWS);
  assert.ok(first.length > 0);
  assert.deepEqual(second, first);
  await app.close();
});
