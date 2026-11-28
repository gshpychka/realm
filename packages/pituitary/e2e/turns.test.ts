import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { palette, theme } from "../packages/tui/src/theme.ts";
import {
  cellsOf,
  copied,
  launch,
  normalMode,
  press,
  RUNNING,
  settled,
  waitGone,
  waitMatch,
} from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

const CTRL_F = "\x06";
const CTRL_O = "\x0f";
const CTRL_T = "\x14";
const UP = "\x1b[A";
const PAGE_UP = "\x1b[5~";
const ALT_HOME = "\x1b[1;3H";
const ALT_END = "\x1b[1;3F";
/** The `steps` scenario's box once its run has ended. */
const DONE = /^ ▸ \S+ read README\.md · searched 3 · ran 2 commands · 1 failed$/m;
/** A turn's figures: the time it worked, its output tokens, and the time of day it ended. */
const FIGURES = /^ \S+ (\d+)s · \S+ \d+ · at \d\d:\d\d$/m;

/** The rows a box takes, from its title to the blank row after it. */
function boxRows(screen: string, title: RegExp): number {
  const rows = screen.split("\n");
  const top = rows.findIndex((row) => title.test(row));
  assert.notEqual(top, -1, `no box titled ${title}:\n${screen}`);
  const end = rows.findIndex((row, index) => index > top && row.trim() === "");
  return end - top;
}

test("a run's work stays a few rows however long it streams, says what it did, and keeps the failure that ended it in view", async () => {
  const app = await launch({ scenario: "steps", delayMs: 40 });
  try {
    await app.terminal.submit("run the steps");
    // The command that builds prints as it goes; its latest line shows under its own.
    const live = await waitMatch(app.terminal, /^ {5}compiling$/m, 15_000);
    await app.capture("turns-rail-live");
    // The title says what is done, and then what is going on, which the command's own row names.
    assert.match(live, /^ ◌ \S+ read README\.md · searched 2 · running a command$/m);
    assert.match(live, /^ {3}… \d+ earlier steps$/m);
    assert.match(live, /^ {3}◌ \$ printf 'compiling/m);
    // The title, the earlier steps' count, three steps, and the command's output.
    assert.ok(boxRows(live, /^ ◌ /) <= 6, live);
    // A call that runs a while shows the time it has taken, whatever its heading leaves.
    await waitMatch(app.terminal, /^ {3}◌ \$ printf 'compiling.*… · [2-9]s$/m, 10_000);

    await app.terminal.waitText("Every step ran; the last check failed.", { timeout: 15_000 });
    const done = await settled(app.terminal, 10_000);
    await app.capture("turns-rail-done");
    // Until the operator sends again, the box keeps its latest steps, so the run's end moves nothing.
    assert.match(done, DONE);
    assert.match(done, /^ {3}✗ \$ printf 'checking\\n'; exit 3$/m);
    const [failed] = await cellsOf(app.terminal, "1 failed");
    assert.equal(failed?.fg, theme.error);
    // The box owns the count of what ran; the turn's figures say how long and when.
    assert.match(done, FIGURES);
    assert.doesNotMatch(done, /\d+ tools?\b/);

    // Opened, the box takes the rows the conversation leaves empty, its short steps a row each.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("━━ ↑↓ move · c copy · esc back ━");
    await app.terminal.write(UP);
    await app.terminal.waitText("enter open · o full length");
    await app.terminal.write("\r");
    const open = await app.terminal.waitText("enter close").then(() => app.terminal.text());
    await app.capture("turns-open-room");
    assert.ok(boxRows(open, /^ ╭ ▾ /) > 28 / 3 + 2, open);
    assert.match(
      open,
      /│ Step 1: read\.\s+\S?│\n │ ✓ \S+ read README\.md · 1 line\s+\S?│\n │ Step 2: grep\./,
    );
    await app.terminal.write("\r");
    await app.terminal.waitText("enter open");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /esc back/);

    // Sent something else, the box folds to its line, and the call that failed under it.
    await app.terminal.submit("once more");
    await waitMatch(app.terminal, /Every step ran[\s\S]*Every step ran/, 20_000);
    const folded = await settled(app.terminal, 10_000);
    await app.capture("turns-folded");
    assert.match(folded, /1 failed\n {3}✗ \$ printf 'checking\\n'; exit 3\n\n ● Every step ran/);
    const [cross] = await cellsOf(app.terminal, "✗ $ printf 'checking");
    assert.equal(cross?.fg, theme.error);

    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /^ …projects\/work\/sample/m);
    await app.terminal.waitIdle();
    const narrow = await app.capture("turns-folded-80");
    assert.match(narrow, DONE);
    assert.match(narrow, /^ {3}✗ \$ printf 'checking\\n'; exit 3$/m);
    // A box opened by hand stays so until ctrl+o sets every box one way, and then goes with them.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "enter open");
    await app.terminal.write("\r");
    await app.terminal.waitText("enter close");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /esc back/);
    // Every box open at full length runs past the conversation's rows, and none of it shows
    // through the draft's row below them.
    await app.terminal.write(CTRL_O);
    await app.terminal.waitText("boxes: all open at full length");
    for (const _ of [1, 2, 3]) {
      await app.terminal.write(PAGE_UP);
      await app.terminal.waitIdle();
      assert.match(await app.terminal.text(), /^ » ask pi$/m);
    }
    await app.capture("turns-whole-80");
    await app.terminal.write(CTRL_O);
    await app.terminal.waitText("boxes: folded");
    await app.terminal.resize(160, 45);
    // The footer's path, cut short at 80 columns, is whole once the wide screen has drawn.
    await waitMatch(app.terminal, /^ ~\/projects\/work\/sample/m);
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.capture("turns-folded-160"), /╭/);
  } finally {
    await app.close();
  }
});

test("snapshots read during a run keep its clock, so it ends with its figures", async () => {
  // Each slow delta of the call's arguments reads the conversation's snapshot again.
  const app = await launch({ scenario: "tool", delayMs: 1000 });
  try {
    await app.terminal.submit("inspect the workspace");
    const preparing = await waitMatch(app.terminal, /preparing bash · [3-9]s · /, 15_000);
    await app.capture("turns-resync-clock");
    // The Faux provider shows a call's arguments only once they are whole, so none are guessed.
    assert.match(preparing, /^ {3}… \$$/m);
    assert.match(preparing, /^ ◌ \S+ running a command$/m);
    await app.terminal.waitText("The workspace inspection is complete.", { timeout: 20_000 });
    const done = await settled(app.terminal, 10_000);
    await app.capture("turns-resync-figures");
    // The command's row under the title names it, so the title does not again.
    assert.match(done, /^ ▸ \S+ ran a command\n {3}✓ \$ printf 'native tool output/m);
    const worked = Number(FIGURES.exec(done)?.[1]);
    assert.ok(worked >= 3, `the turn's figures lost the run's start:\n${done}`);
  } finally {
    await app.close();
  }
});

test("scrolled back during a run, the draft's rule says more is below, and alt+end goes back to it", async () => {
  const app = await launch({ scenario: "long", delayMs: 120 });
  try {
    await app.terminal.submit("write a lot");
    // Once the answer is taller than the conversation's rows, there is somewhere to scroll back to.
    await app.terminal.waitText("line 14 of the long answer", { timeout: 10_000 });
    await app.terminal.write(PAGE_UP);
    const away = await waitMatch(app.terminal, /━━ ↓ more below · alt\+end ━/);
    await app.capture("turns-more-below");
    assert.match(away, RUNNING);
    await app.terminal.write(ALT_END);
    await waitMatch(app.terminal, /^(?![\s\S]*more below)/);
    // Back at the latest rows, the view follows what comes.
    const latest = await waitMatch(app.terminal, /line 2\d of the long answer/, 10_000);
    assert.doesNotMatch(latest, /▌ write a lot/);
    await app.terminal.write(ALT_HOME);
    await app.terminal.waitText("▌ write a lot");
  } finally {
    await app.close();
  }
});

test("the transcript cursor stops on each prompt, box, reply and notice, offering only the keys each one has", async () => {
  const app = await launch({ scenario: "steps", record: true });
  try {
    await app.terminal.submit("run the steps");
    await app.terminal.waitText("Every step ran; the last check failed.", { timeout: 15_000 });
    await settled(app.terminal, 10_000);
    await app.terminal.submit("/session");
    await app.terminal.waitText("tokens:");
    await app.terminal.waitIdle();

    // The cursor starts on the latest item: the notice /session wrote.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("━━ ↑↓ move · c copy · esc back ━");

    await app.terminal.write(UP);
    await waitMatch(app.terminal, /^┃● Every step ran/m);
    await app.terminal.write("c");
    await app.terminal.waitText("━━ copied the reply ━");
    await app.terminal.waitIdle();
    assert.equal(copied(app.raw()), "Every step ran; the last check failed.");
    const reply = await app.capture("turns-cursor-reply");
    const [bar] = await app.terminal.cells(
      0,
      reply.split("\n").findIndex((row) => row.startsWith("┃●")),
      1,
      1,
    );
    assert.equal(bar?.fg, theme.cursor);

    // A box: copy its steps, open and close it, show it at full length; it takes no bar of its own.
    // Keys that arrive together act where the moves before them landed.
    await app.terminal.write(`${UP}c`);
    await app.terminal.waitText("copied the box's steps");
    await app.terminal.waitIdle();
    assert.match(
      copied(app.raw()),
      /^Step 1: read\.\n\nread README\.md[\s\S]*\$ printf 'checking\\n'; exit 3\nchecking/,
    );
    await app.terminal.waitText("↑↓ move · enter open · o full length · c copy · esc back");
    const [title] = await cellsOf(app.terminal, "read README.md · searched 3");
    assert.equal(title?.fg, theme.cursor);
    assert.notEqual(title?.bg, palette.surface);
    await app.terminal.write("\r");
    await app.terminal.waitText("enter close · o full length · j k scroll · c copy");
    await app.capture("turns-cursor-box-open");
    await app.terminal.write("o");
    await app.terminal.waitText("enter close · o bound · c copy");
    const whole = await app.terminal.text();
    assert.match(whole, /Command exited with code 3/);
    // The run's end read the conversation again, and each call kept the time it took.
    assert.match(whole, /printf 'built\\n' · 3\.\ds/);
    await app.capture("turns-cursor-box-whole");
    // Hidden, thinking that led straight to a call marks that call instead of taking a row.
    await app.terminal.write(CTRL_T);
    await app.terminal.waitText("thinking: hidden");
    const marked = await app.capture("turns-cursor-box-thought");
    assert.match(marked, /^ │ \S+ ✓ \S+ ls src/m);
    assert.doesNotMatch(marked, /thought · \d+ lines?/);
    await app.terminal.write(CTRL_T);
    await app.terminal.waitText("thinking: shown");

    // A prompt keeps its own band; the cursor's bar runs beside it. Dura has no fork or edit.
    await app.terminal.write(UP);
    await app.terminal.waitText("━━ ↑↓ move · c copy · esc back ━");
    const prompt = await waitMatch(app.terminal, /^┃▌ run the steps/m);
    await app.capture("turns-cursor-prompt");
    assert.doesNotMatch(prompt, /f fork|e edit/);
    const [band] = await cellsOf(app.terminal, "run the steps");
    assert.equal(band?.bg, palette.surface);

    await app.terminal.write("\x1b");
    await waitMatch(app.terminal, /^(?![\s\S]*esc back)/);
    assert.doesNotMatch(await app.terminal.text(), /^┃/m);
  } finally {
    await app.close();
  }
});

test("replies with no call between them each stand as a reply, which the cursor steps through", async () => {
  const app = await launch({ scenario: "sprawl" });
  try {
    const screen = await app.terminal
      .waitText("step 300: retained native history")
      .then(() => app.terminal.text());
    await app.capture("turns-sprawl");
    assert.match(screen, /^ ● step 299: retained native history\n\n ● step 300/m);
    assert.doesNotMatch(screen, /^ ▸ *$/m);
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("━━ ↑↓ move · c copy · esc back ━");
    await app.terminal.write(UP);
    await waitMatch(app.terminal, /^┃● step 299/m);
    // Keys the cursor has no use for stay out of the draft.
    await app.terminal.write("jj");
    await app.terminal.waitIdle();
    assert.match(await app.terminal.text(), /^ » ask pi$/m);
    // Up past the first drawn reply draws the ones before it, and goes on into them.
    await app.terminal.write(UP.repeat(149));
    await waitMatch(app.terminal, /^┃● step 150: retained native history/m);
  } finally {
    await app.close();
  }
});

test("thinking reads as going on while it does and as done after, and ctrl+t says which way it went", async () => {
  const app = await launch({ scenario: "thinking", delayMs: 150 });
  try {
    await app.terminal.submit("consider this");
    await waitMatch(app.terminal, /^ ◌ \S+ thinking…$/m, 10_000);
    await app.terminal.waitText("You said: consider this", { timeout: 10_000 });
    const done = await settled(app.terminal, 10_000);
    assert.match(done, /^ ▸ \S+ thought$/m);
    assert.match(done, /^ {3}I will reason through the request\.$/m);
    await app.terminal.write(CTRL_T);
    await app.terminal.waitText("thinking: hidden");
    await waitMatch(app.terminal, /^ {3}\S+ thought$/m);
    await waitMatch(app.terminal, /^(?![\s\S]*thinking: hidden)/);
    // Opened, hidden thinking says how much of it there is and which key shows it.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "enter open");
    await app.terminal.write("\r");
    await app.terminal.waitText("thought · 1 line · ctrl+t");
    await app.capture("turns-thinking-hidden");
    await app.terminal.write(CTRL_T);
    await app.terminal.waitText("thinking: shown");
    await waitGone(app.terminal, /thinking: shown/);
    // Pressed twice before the screen redraws, it goes one way and back.
    await app.terminal.write(CTRL_T + CTRL_T);
    await app.terminal.waitText("thinking: shown");
    assert.match(await app.terminal.text(), /^ │ I will reason through the request\./m);
  } finally {
    await app.close();
  }
});

test("an interruption ends the calls running as interrupted, not failed, and a reply it cut before any words has nothing to copy", async () => {
  const steps = await launch({ scenario: "steps", delayMs: 40 });
  try {
    await steps.terminal.submit("run the steps");
    await waitMatch(steps.terminal, /^ {5}compiling$/m, 15_000);
    await normalMode(steps.terminal);
    await steps.terminal.keyboard.press("Escape");
    const stopped = await settled(steps.terminal, 10_000);
    await steps.capture("turns-interrupted-call");
    assert.match(stopped, /^ ▸ \S+ read README\.md · searched 2 · ran a command · 1 interrupted$/m);
    assert.doesNotMatch(stopped, /failed/);
    const [word] = await cellsOf(steps.terminal, "1 interrupted");
    assert.notEqual(word?.fg, theme.error);
    const [cross] = await cellsOf(steps.terminal, "✗ $ printf 'compiling");
    assert.notEqual(cross?.fg, theme.error);
  } finally {
    await steps.close();
  }
  const thinking = await launch({ scenario: "thinking", delayMs: 400 });
  try {
    await thinking.terminal.submit("consider this");
    await waitMatch(thinking.terminal, /^ ◌ \S+ thinking…$/m, 10_000);
    await normalMode(thinking.terminal);
    await thinking.terminal.keyboard.press("Escape");
    await thinking.terminal.waitText("interrupted");
    await settled(thinking.terminal, 10_000);
    await thinking.terminal.write(CTRL_F);
    await thinking.terminal.waitText("━━ ↑↓ move · esc back ━");
    await thinking.capture("turns-interrupted-reply");
  } finally {
    await thinking.close();
  }
});
