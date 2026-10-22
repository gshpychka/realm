import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { theme } from "../packages/tui/src/theme.ts";
import { click, launch, pastGrace, waitMatch, wheel } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const CTRL_F = "\x06";
const CTRL_O = "\x0f";
const UP = "\x1b[A";
const FOLDED = re`▸ ${glyphs.tool} 6 tools · 1 failed`;

after(async () => {
  await closeAll();
});

/** The screen's rows, top first. */
const rowsOf = async (terminal: TuiTest) => (await terminal.text()).split("\n");

/** The row of the first line on the screen holding `text`, or of the last with `last`. */
async function rowOf(terminal: TuiTest, text: string, last = false): Promise<number> {
  const rows = await rowsOf(terminal);
  const row = last
    ? rows.findLastIndex((line) => line.includes(text))
    : rows.findIndex((line) => line.includes(text));
  assert.ok(row >= 0, `"${text}" is not on the screen:\n${rows.join("\n")}`);
  return row;
}

/** Resolves once `check` holds, polling the screen as it settles. */
async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Runs the `tools` scenario once per prompt, each run leaving one folded box. */
async function twoRuns(terminal: TuiTest): Promise<void> {
  await terminal.submit("first");
  await terminal.waitText("Done.");
  await terminal.submit("second");
  await waitMatch(terminal, /▌ second[\s\S]*Done\./);
}

test("the model works in an open box that follows its latest step, and it folds to one line once the reply ends", async () => {
  const app = await launch({ scenario: "phases", rows: 30 });
  await app.terminal.submit("clean up");
  // Narration draws once its markdown is parsed, a moment after the rest of the box.
  const working = await waitMatch(
    app.terminal,
    /Clearing the build directory[\s\S]*◌ \$ rm -rf build[\s\S]*bash wants to run/,
  );
  await app.capture("work-live");
  assert.match(working, re`╭ ▾ ${glyphs.tool} thought · 2 tools ─+╮`, working);
  assert.match(working, /│ Clearing the build directory\./, `narration is not in the box:\n${working}`);
  // Ten rows, a third of the screen, hold the latest steps; the first scrolled out above them.
  assert.doesNotMatch(working, /Checking what the build leaves behind/, working);

  await pastGrace();
  await app.terminal.write("y");
  const done = await waitMatch(app.terminal, /Cleared \(yes\)\./);
  await app.capture("work-folded");
  assert.match(done, re`▸ ${glyphs.tool} thought · 2 tools\n\n ● Cleared \(yes\)\.`, done);
  assert.doesNotMatch(done, /Listing the directory|rm -rf build/, done);
  await app.close();
});

test("a press on a box's line opens it to a third of the screen, and the wheel scrolls it before the conversation", async () => {
  const app = await launch({ scenario: "tools", rows: 30 });
  await twoRuns(app.terminal);
  await click(app.terminal, 2, await rowOf(app.terminal, "6 tools · 1 failed", true));
  await app.terminal.waitText("╰");
  const opened = await app.capture("work-open");
  const top = await rowOf(app.terminal, "╭");
  assert.equal((await rowOf(app.terminal, "╰")) - top, 11, `the box holds more than ten rows:\n${opened}`);
  assert.match(opened, /╭[^\n]*\n │ Reading first\./, `the box opened past its first step:\n${opened}`);

  const prompt = await rowOf(app.terminal, "▌ second");
  await wheel(app.terminal, 10, top + 4, 3);
  await waitMatch(app.terminal, /╭[^\n]*\n │ (?!Reading first)/);
  assert.equal(await rowOf(app.terminal, "▌ second"), prompt, "the conversation scrolled with the box");

  // Back at the box's first row, the rest of the turn scrolls the conversation.
  await wheel(app.terminal, 10, top + 4, -8);
  await waitMatch(app.terminal, /╭[^\n]*\n │ Reading first\./);
  await eventually(
    async () => (await rowOf(app.terminal, "▌ second")) > prompt,
    "the conversation did not take the wheel at the box's end",
  );
  await app.capture("work-handed-over");

  await click(app.terminal, 2, await rowOf(app.terminal, "╭"));
  await waitMatch(app.terminal, /▸[^\n]*6 tools[\s\S]*▸[^\n]*6 tools/);
  await app.close();
});

test("ctrl+o opens every box at full length, and again folds them", async () => {
  const app = await launch({ scenario: "tools", rows: 80 });
  await twoRuns(app.terminal);
  await app.terminal.write(CTRL_O);
  const whole = await waitMatch(app.terminal, /source line 30[\s\S]*✗ \$ false[\s\S]*Done\./);
  await app.capture("work-whole");
  assert.doesNotMatch(whole, FOLDED, whole);
  assert.match(whole, /│ *check 1 *│/, `a command's output is cut:\n${whole}`);
  await app.terminal.write(CTRL_O);
  await waitMatch(app.terminal, re`${FOLDED}[\s\S]*${FOLDED}`);
  await app.close();
});

test("ctrl+f walks the boxes: up and down pick one, enter opens it, j and k scroll it, and esc hands the keyboard back", async () => {
  const app = await launch({ scenario: "tools", rows: 30 });
  await twoRuns(app.terminal);
  await app.terminal.write(CTRL_F);
  await app.terminal.waitText("↑↓ pick · enter open · j k scroll · esc back");
  const picked = async () => {
    const rows = await rowsOf(app.terminal);
    const lines = rows.flatMap((line, row) => (line.includes("6 tools · 1 failed") ? [row] : []));
    const lit = [];
    for (const row of lines) {
      const [arrow] = (await app.terminal.cells(1, row, 1, 1)) ?? [];
      if (arrow?.fg === theme.user) lit.push(row);
    }
    return { lines, lit };
  };
  const latest = await picked();
  assert.deepEqual(latest.lit, [latest.lines.at(-1)], "the latest box is not the one picked");

  await app.terminal.write(UP);
  await eventually(async () => {
    const { lines, lit } = await picked();
    return lit.length === 1 && lit[0] === lines[0];
  }, "up did not pick the earlier box");

  await app.terminal.write("\r");
  await waitMatch(app.terminal, /╭[^\n]*\n │ Reading first\./);
  await app.capture("work-browse-open");
  await app.terminal.write("jjj");
  await waitMatch(app.terminal, /╭[^\n]*\n │ (?!Reading first)/);
  await app.terminal.write("kkk");
  await waitMatch(app.terminal, /╭[^\n]*\n │ Reading first\./);

  await app.terminal.write("\x1b");
  await waitMatch(app.terminal, /^(?![\s\S]*↑↓ pick)/);
  await app.terminal.type("back in the draft");
  await app.terminal.waitText("» back in the draft");
  await app.close();
});

test("ctrl+f with no thinking or tool calls says so and leaves the keyboard with the draft", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await app.terminal.write(CTRL_F);
  await app.terminal.waitText("no thinking or tool calls to step through yet");
  await app.terminal.type("still typing");
  await app.terminal.waitText("» still typing");
  await app.close();
});
