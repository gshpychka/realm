import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { drag, launch, normalMode, RUNNING, waitMatch } from "./helpers/harness.ts";

/** A rule, with a passing note drawn into it or without one. */
const RULE = /^━+( .+ ━+)?$/;
const BORDER = "#504945";
const TOOL = "#fe8019";
const DIM = "#7c6f64";
const CTRL_J = "\n";
const CTRL_C = "\x03";

after(async () => {
  await closeAll();
});

/** The rows of the two rules around the draft, and the draft's rows between them. */
function frame(screen: string): { above: number; below: number; draft: string[] } {
  const lines = screen.split("\n");
  const below = lines.findLastIndex((line) => RULE.test(line.trim()));
  const above = lines.slice(0, below).findLastIndex((line) => RULE.test(line.trim()));
  return { above, below, draft: lines.slice(above + 1, below) };
}

/** The screen column `text` starts at on the lowest row that holds it; every character before it takes one cell. */
async function columnOf(terminal: TuiTest, text: string): Promise<number> {
  const line = (await terminal.text()).split("\n").findLast((each) => each.includes(text)) ?? "";
  return [...line.slice(0, line.indexOf(text))].length;
}

/** The screen's rows, top first. */
const rowsOf = (screen: string) => screen.split("\n");

/** The first row of `screen` that holds `text`. */
const rowOf = (screen: string, text: string) => rowsOf(screen).findIndex((row) => row.includes(text));

/** The colour of a rule's first cell. */
async function colourOf(terminal: TuiTest, row: number): Promise<unknown> {
  const [cell] = await terminal.cells(0, row, 1, 1);
  return cell?.fg;
}

test("the draft sits between two full-width rules, with the footer under the lower one", async () => {
  const app = await launch({ scenario: "hello" });
  const screen = await app.capture("frame-idle");
  const lines = screen.split("\n");
  const { above, below, draft } = frame(screen);
  assert.deepEqual(draft, [" » ask pi · !cmd runs a shell command"], screen);
  assert.equal(below, lines.length - 2, `the footer is not under the lower rule:\n${screen}`);
  assert.equal(lines[above]?.length, 100, screen);
  assert.equal(await colourOf(app.terminal, above), BORDER);
  assert.equal(await colourOf(app.terminal, below), BORDER);
  await app.close();
});

test("a shell command draft colours both rules", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("!ls");
  await app.terminal.waitText("$ !ls");
  const screen = await app.capture("frame-command");
  const { above, below } = frame(screen);
  assert.equal(await colourOf(app.terminal, above), TOOL);
  assert.equal(await colourOf(app.terminal, below), TOOL);
  await app.close();
});

test("the rules move apart as the draft grows, up to eight rows", async () => {
  const app = await launch({ scenario: "hello" });
  for (let line = 1; line <= 3; line++) {
    if (line > 1) await app.terminal.write(CTRL_J);
    await app.terminal.type(`line ${line}`);
  }
  await app.terminal.waitText("line 3");
  const three = await app.capture("frame-multiline");
  assert.equal(frame(three).draft.length, 3, three);
  for (let line = 4; line <= 12; line++) {
    await app.terminal.write(CTRL_J);
    await app.terminal.type(`line ${line}`);
  }
  await app.terminal.waitText("line 12");
  const full = await app.terminal.text();
  const { draft } = frame(full);
  assert.equal(draft.length, 8, full);
  assert.match(draft.at(-1) ?? "", /line 12/, full);
  await app.close();
});

test("a narrow terminal keeps both rules the full width", async () => {
  const app = await launch({ scenario: "hello", cols: 40 });
  await app.terminal.type("a draft");
  await app.terminal.waitText("» a draft");
  const screen = await app.capture("frame-narrow");
  const lines = screen.split("\n");
  const { above, below } = frame(screen);
  assert.equal(lines[above], "━".repeat(40), screen);
  assert.equal(lines[below], "━".repeat(40), screen);
  await app.close();
});

/** Asserts `text` still starts at `column`, after `what`. */
async function stays(terminal: TuiTest, text: string, column: number, what: string): Promise<void> {
  assert.equal(await columnOf(terminal, text), column, `${what} moved the draft`);
}

test("the draft keeps its column whatever mark stands beside it while idle", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("abc");
  await app.terminal.waitText("\u00bb abc");
  const column = await columnOf(app.terminal, "abc");
  await normalMode(app.terminal);
  await stays(app.terminal, "abc", column, "normal mode");
  await app.terminal.type("I!");
  await app.terminal.waitText("$ !abc");
  await stays(app.terminal, "!abc", column, "a shell command");
  await app.close();
});

test("the draft keeps its column under the steering mark while pi works, in either mode", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  const column = await columnOf(app.terminal, "ask pi");
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.type("def");
  await app.terminal.waitText(`${glyphs.steering} def`);
  await app.capture("frame-mark-steering");
  await stays(app.terminal, "def", column, "steering");
  await normalMode(app.terminal);
  assert.match(await app.capture("frame-mark-steering-normal"), RUNNING);
  await stays(app.terminal, "def", column, "normal mode during a run");
  await app.close();
});

test("a passing hint while idle is drawn into the rule above the draft, and nothing above it moves", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("hi");
  const before = await waitMatch(app.terminal, /^(?![\s\S]* · \d+s · )[\s\S]*You said: hi/);
  const { above } = frame(before);
  // Copying a selection is what flashes the hint.
  const start = rowsOf(before)[rowOf(before, "You said: hi")]?.indexOf("You said: hi") ?? 0;
  await drag(app.terminal, rowOf(before, "You said: hi"), start, start + 11);
  await app.terminal.waitText("copied");
  const during = await app.capture("frame-hint");
  assert.match(rowsOf(during)[above] ?? "", /^━━ copied ━{90}$/, during);
  const [letter] = await app.terminal.cells(3, above, 1, 1);
  assert.equal(letter?.fg, DIM);
  assert.deepEqual(rowsOf(during).slice(0, above), rowsOf(before).slice(0, above), during);
  const gone = await waitMatch(app.terminal, /^(?![\s\S]*copied)/, 5000);
  assert.deepEqual(rowsOf(gone).slice(0, above + 1), rowsOf(before).slice(0, above + 1), gone);
  await app.close();
});

test("a hint longer than the rule has room for is cut to fit it", async () => {
  const app = await launch({ scenario: "hello", cols: 24 });
  await app.terminal.write(CTRL_C);
  await app.terminal.waitText("ctrl+c again");
  const screen = await app.capture("frame-hint-narrow");
  assert.equal(screen.split("\n")[frame(screen).above], "━━ ctrl+c again to q… ━━", screen);
  await app.close();
});
