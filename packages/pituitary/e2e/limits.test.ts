import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { click, launch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const RED = "#fb4934";
const YELLOW = "#fabd2f";
const TEXT = "#ebdbb2";
const DIM = "#a89984";

/** The divider between parts of the budget's band, for the default arrow separator. */
const INNER = "\u{e0b3}";

/** The fire lights the cells around it; tests of colour read the footer by its own light. */
const UNLIT = { PITUITARY_FIRELIGHT: "off" };

after(async () => {
  await closeAll();
});

/** The footer's cells, with the column and row of each. */
async function footerCells(terminal: TuiTest, cols: number, rows: number) {
  const cells = await terminal.cells(0, rows - 2, cols, 2);
  return cells.map((cell, index) => ({
    ...cell,
    col: index % cols,
    row: rows - 2 + Math.floor(index / cols),
  }));
}

/** The colour of the first footer cell, from the left, that starts `text`. */
async function colourOf(terminal: TuiTest, text: string, cols = 100, rows = 28): Promise<unknown> {
  const cells = await footerCells(terminal, cols, rows);
  // Cells hold one or no character, and astral glyphs take two string positions, so each
  // position in the text maps back to its cell.
  let chars = "";
  const owner: number[] = [];
  cells.forEach((cell, index) => {
    for (let unit = 0; unit < cell.char.length; unit++) owner.push(index);
    chars += cell.char;
  });
  const at = chars.indexOf(text);
  return at < 0 ? undefined : cells[owner[at] ?? -1]?.fg;
}

async function clickCard(terminal: TuiTest, cols = 100, rows = 28): Promise<void> {
  const card = (await footerCells(terminal, cols, rows)).find((cell) => cell.char === glyphs.card);
  assert.ok(card, "no card on the footer");
  await click(terminal, card.col, card.row);
}

async function afterReply(scenario: string, cols = 100) {
  const app = await launch({ scenario, cols, env: UNLIT });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await app.terminal.waitText(glyphs.card);
  return app;
}

const footerOf = (screen: string) => screen.split("\n").slice(-2).join("\n");

test("limits well within reach stay behind a quiet card, which a click opens", async () => {
  const app = await afterReply("limits-calm");
  const closed = footerOf(await app.capture("limits-calm"));
  assert.doesNotMatch(closed, /5h|wk|\$0\.01/, `limits out of the card:\n${closed}`);
  assert.equal(await colourOf(app.terminal, glyphs.card), DIM);
  await clickCard(app.terminal);
  await app.terminal.waitText("5h 34%");
  const open = footerOf(await app.capture("limits-calm-open"));
  assert.ok(
    open.includes(`${glyphs.card} $0.01 ${INNER} 5h 34% ${INNER} wk 12% `),
    `limits missing:\n${open}`,
  );
  assert.doesNotMatch(open, /↻/, `reset shown for calm limits:\n${open}`);
  assert.ok(!open.includes("extra"), `extra usage shown while unused:\n${open}`);
  assert.equal(await colourOf(app.terminal, "34%"), TEXT);
  await app.close();
});

test("a limit past ninety percent opens the card on its own, alarms, and says when it resets", async () => {
  const app = await afterReply("limits-warning");
  await app.terminal.waitText("wk 93%");
  const footer = footerOf(await app.capture("limits-warning"));
  assert.ok(footer.includes(`5h 62% ${INNER} wk 93% ↻ 2d `), footer);
  assert.equal(await colourOf(app.terminal, "62%"), TEXT);
  assert.equal(await colourOf(app.terminal, "93%"), RED);
  assert.equal(await colourOf(app.terminal, glyphs.card), RED);
  await app.close();
});

test("extra usage shows in the open card, with how much of the month it has spent", async () => {
  const app = await afterReply("limits-extra");
  await app.terminal.waitText("extra 42%");
  const footer = footerOf(await app.capture("limits-extra"));
  assert.match(footer, re`5h 100% ↻ \d+m ${INNER} wk 71% ${INNER} extra 42% `, footer);
  assert.equal(await colourOf(app.terminal, "100%"), RED);
  assert.equal(await colourOf(app.terminal, "42%"), YELLOW);
  await app.close();
});

test("a narrow footer keeps each limit's figure, giving up the fire and the reset", async () => {
  const app = await afterReply("limits-extra", 60);
  await app.terminal.waitText("extra 42%");
  const footer = footerOf(await app.capture("limits-extra-narrow"));
  assert.ok(footer.includes("$0.01"), `cost cut:\n${footer}`);
  assert.ok(footer.includes("5h 100%") && footer.includes("wk 71%"), `a limit cut:\n${footer}`);
  assert.ok(footer.includes("extra 42%"), `extra usage cut:\n${footer}`);
  assert.ok(!footer.includes("↻"), `the reset outlasted the room:\n${footer}`);
  await app.close();
});

test("/usage lists every window, extra usage, and where to find spend in dollars", async () => {
  const app = await afterReply("limits-extra");
  await app.terminal.submit("/usage");
  await app.terminal.waitText("Spend in dollars");
  const screen = await app.capture("limits-usage");
  assert.match(screen, /five-hour\s+100% used · resets in \d+ minutes · the limit that applies now/, screen);
  assert.match(screen, /weekly\s+71% used · resets in 3 days/, screen);
  assert.ok(screen.includes("Extra usage is in use"), screen);
  assert.ok(screen.includes("42% of this month's spending cap is spent."), screen);
  await app.close();
});

test("no limits show before a reply reports them", async () => {
  const app = await afterReply("hello");
  await clickCard(app.terminal);
  await app.terminal.waitText("$0.01");
  const footer = footerOf(await app.terminal.text());
  assert.doesNotMatch(footer, /5h|wk|extra/, footer);
  await app.terminal.submit("/usage");
  await app.terminal.waitText("No usage limits reported yet");
  await app.close();
});
