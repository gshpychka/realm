import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { BRANCH, click, launch, normalMode, PROJECT } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const RED = "#fb4934";
const YELLOW = "#fabd2f";
const FAINT = "#7c6f64";
const ORANGE = "#fe8019";
const TEXT = "#ebdbb2";
const TERRA_COTTA = "#d97757";
const BAR = "#282828";
const OUTER = "#504945";
const INNER = "#3c3836";
const FIREBOX = "#1d2021";

/** The fire lights the cells around it; tests of colour read the footer by its own light. */
const UNLIT = { PITUITARY_FIRELIGHT: "off" };

after(async () => {
  await closeAll();
});

/** The footer's two rows as cells, each with where it sits. */
async function footerCells(terminal: TuiTest, cols = 100, rows = 28) {
  const cells = await terminal.cells(0, rows - 2, cols, 2);
  return cells.map((cell, index) => ({
    ...cell,
    col: index % cols,
    row: rows - 2 + Math.floor(index / cols),
  }));
}

/** The colour of the first cell on the footer rows holding `char`. */
async function colourOf(terminal: TuiTest, char: string, cols = 100, rows = 28): Promise<unknown> {
  return (await footerCells(terminal, cols, rows)).find((cell) => cell.char === char)?.fg;
}

async function clickCard(terminal: TuiTest): Promise<void> {
  const card = (await footerCells(terminal)).find((cell) => cell.char === glyphs.card);
  assert.ok(card, "no card on the footer");
  await click(terminal, card.col, card.row);
}

test("an idle session fits the footer on one row, the cost closed behind the card", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await app.terminal.waitText("ctx 7%");
  const screen = await app.capture("footer");
  const footer = screen.split("\n").at(-1) ?? "";
  assert.ok(footer.startsWith(` ~/${PROJECT} `), `directory missing:\n${footer}`);
  assert.ok(footer.includes(`${glyphs.branch} ${BRANCH} `), `branch missing:\n${footer}`);
  assert.ok(
    footer.includes(`${glyphs.model} fake-model-1 ${glyphs.thinking} medium`),
    `model missing:\n${footer}`,
  );
  assert.ok(footer.includes(glyphs.card), `card missing:\n${footer}`);
  assert.ok(!footer.includes("$0.01"), `cost out of the card:\n${footer}`);
  const beneath = screen.slice(screen.lastIndexOf("━") + 1);
  assert.doesNotMatch(beneath, /\(fake\)|↑|↓|CH\d/, `pi's abbreviations left in:\n${screen}`);
  assert.ok(screen.split("\n").at(-3)?.includes("ask pi"), `footer took more than one row:\n${screen}`);
  const cells = await footerCells(app.terminal);
  assert.equal(cells.at(-1)?.col, 99);
  assert.notEqual(cells.at(-1)?.bg, BAR, "the footer ends in the bar, not the hearth");
  assert.equal(
    cells.find((cell) => cell.row === 27)?.bg,
    OUTER,
    "the footer's left edge is not the outer band",
  );
  await app.close();
});

test("a click on the card shows the cost beside it, and another hides it again", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("hi");
  await app.terminal.waitText("ctx 7%");
  await clickCard(app.terminal);
  await app.terminal.waitText(`${glyphs.card} $0.01`);
  await app.capture("footer-card-open");
  assert.equal(await colourOf(app.terminal, glyphs.card), TEXT);
  assert.equal(await colourOf(app.terminal, "$"), TEXT);
  await clickCard(app.terminal);
  await app.terminal.waitText("$0.01", { not: true });
  await app.capture("footer-card-closed");
  assert.equal(await colourOf(app.terminal, glyphs.card), "#a89984");
  await app.close();
});

test("clicks in one place open and close the card, and select none of its text", async () => {
  const app = await launch({ scenario: "hello", env: UNLIT });
  await app.terminal.submit("hi");
  await app.terminal.waitText("ctx 7%");
  const card = (await footerCells(app.terminal)).find((cell) => cell.char === glyphs.card);
  assert.ok(card, "no card on the footer");
  // Opening moves the card's mark left and puts the cost under the pointer, quick enough for a double click.
  for (const open of [true, false, true]) {
    await click(app.terminal, card.col, card.row);
    await app.terminal.waitText("$0.01", { not: !open });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const screen = await app.capture("footer-card-clicks");
  const lit = (await footerCells(app.terminal)).filter((cell) => cell.bg === TEXT);
  assert.equal(lit.map((cell) => cell.char).join(""), "", `the clicks selected text:\n${screen}`);
  assert.doesNotMatch(screen, /copied/, screen);
  await app.close();
});

test("the footer names the branch the working directory has checked out", async () => {
  const app = await launch({ scenario: "hello", branch: "feat/limits" });
  const screen = await app.capture("footer-branch");
  const footer = screen.split("\n").at(-1) ?? "";
  assert.ok(footer.includes(`${glyphs.branch} feat/limits`), `branch missing:\n${footer}`);
  assert.equal(await colourOf(app.terminal, "f"), ORANGE);
  await app.close();
});

test("outside a repository the footer shows the directory and no branch", async () => {
  const app = await launch({ scenario: "hello", branch: false });
  const screen = await app.capture("footer-no-git");
  const footer = screen.split("\n").at(-1) ?? "";
  assert.ok(footer.includes(`~/${PROJECT}`), `directory missing:\n${footer}`);
  assert.ok(!footer.includes(glyphs.branch), `branch shown:\n${footer}`);
  await app.close();
});

test("the context percentage turns red past ninety percent", async () => {
  const app = await launch({ scenario: "crowded" });
  await app.terminal.waitText("93%");
  await app.capture("footer-crowded");
  const cells = await footerCells(app.terminal);
  const percent = cells.findIndex((cell, index) => cell.char === "9" && cells[index + 1]?.char === "3");
  assert.equal(cells[percent]?.fg, RED);
  assert.equal(cells[percent]?.bg, INNER);
  await app.close();
});

test("extension statuses become icons, quiet while healthy and in their tone with words otherwise", async () => {
  const app = await launch({ scenario: "statuses", env: UNLIT });
  await app.terminal.submit("hi");
  await app.terminal.waitText("Statuses set");
  await app.terminal.waitText(`${glyphs.mcp} 1/2`);
  const idle = await app.capture("footer-statuses");
  assert.doesNotMatch(idle, /LSP|Inactive|checkpoints|servers/, `status words left in:\n${idle}`);
  assert.ok(idle.includes("• indexing 42 files"), `unknown status lost its text:\n${idle}`);
  assert.ok(idle.includes(`${glyphs.guard} 2`), `auto mode lost its denied count:\n${idle}`);
  assert.doesNotMatch(idle, /AM ●|a:7/, `auto mode words left in:\n${idle}`);
  assert.equal(await colourOf(app.terminal, glyphs.lsp), FAINT);
  assert.equal(await colourOf(app.terminal, glyphs.mcp), YELLOW);
  assert.equal(await colourOf(app.terminal, glyphs.unlocked), RED);
  assert.equal(await colourOf(app.terminal, glyphs.plan), YELLOW);
  assert.equal(await colourOf(app.terminal, glyphs.guard), YELLOW);

  await app.terminal.submit("activate");
  await app.terminal.waitText("Servers up");
  await app.terminal.waitText(`${glyphs.mcp} 1/2`, { not: true });
  await app.capture("footer-statuses-active");
  assert.equal(await colourOf(app.terminal, glyphs.lsp), FAINT);
  assert.equal(await colourOf(app.terminal, glyphs.mcp), FAINT);
  await app.close();
});

test("the auto mode shield counts the actions denied this turn, and is red while auto mode is off", async () => {
  const app = await launch({ scenario: "automode", env: UNLIT });
  const counted = re`${glyphs.guard} \d`;
  const footer = async (name: string) => (await app.capture(name)).split("\n").slice(-2).join("\n");

  await app.terminal.submit("first");
  await app.terminal.waitText("Turn first done");
  await app.terminal.waitText(`${glyphs.guard} 2`);
  await footer("footer-automode-denied");
  assert.equal(await colourOf(app.terminal, glyphs.guard), YELLOW);

  await app.terminal.submit("second");
  await app.terminal.waitText("Turn second done");
  await app.terminal.waitText(`${glyphs.guard} 2`, { not: true });
  const clear = await footer("footer-automode-clear");
  assert.ok(clear.includes(glyphs.guard), `shield missing:\n${clear}`);
  assert.doesNotMatch(clear, counted, `a turn with no denials shows a count:\n${clear}`);
  assert.equal(await colourOf(app.terminal, glyphs.guard), FAINT);

  await app.terminal.submit("third");
  await app.terminal.waitText("Turn third done");
  await app.terminal.waitText(`${glyphs.guard} 1`);
  const again = await footer("footer-automode-denied-again");
  assert.doesNotMatch(again, /d:|AM/, `auto mode words left in:\n${again}`);
  assert.equal(await colourOf(app.terminal, glyphs.guard), YELLOW);

  await app.terminal.submit("off");
  await app.terminal.waitText("Turn off done");
  await app.terminal.waitText(`${glyphs.guard} 1`, { not: true });
  const off = await footer("footer-automode-off");
  assert.doesNotMatch(off, counted, `auto mode off shows a count:\n${off}`);
  assert.equal(await colourOf(app.terminal, glyphs.guard), RED);
  await app.close();
});

test("the footer stays put while a reply streams", async () => {
  const app = await launch({ scenario: "long", delayMs: 40 });
  await app.terminal.submit("go");
  await app.terminal.waitText("line 3 of the long answer");
  const screen = await app.capture("footer-running");
  assert.ok(screen.includes(`fake-model-1 ${glyphs.thinking} medium`), screen);
  await app.close();
});

test("a narrow terminal puts the place and statuses above the budget, the model, and the hearth", async () => {
  const app = await launch({ scenario: "statuses", cols: 60, rows: 20 });
  await app.terminal.submit("hi");
  await app.terminal.waitText("Statuses set");
  await app.terminal.waitText(glyphs.agents);
  const screen = await app.capture("footer-narrow");
  const [place, budget] = screen.split("\n").slice(-2);
  assert.ok(place?.includes(`${glyphs.branch} ${BRANCH}`), `branch lost:\n${screen}`);
  assert.ok(place?.includes(glyphs.agents) && place.includes(glyphs.mcp), `statuses lost:\n${screen}`);
  assert.ok(budget?.includes(`fake-model-1 ${glyphs.thinking} medium`), `model lost:\n${screen}`);
  assert.ok(budget?.includes(`ctx 7%`) && budget.includes(glyphs.card), `budget lost:\n${screen}`);
  const cells = await footerCells(app.terminal, 60, 20);
  assert.equal(cells.filter((cell) => cell.row === 19 && cell.col >= 52).length, 8);
  await app.close();
});

for (const cols of [40, 30]) {
  test(`at ${cols} columns the footer sheds whole parts and keeps every figure intact`, async () => {
    const app = await launch({ scenario: "statuses", cols, rows: 16 });
    await app.terminal.submit("hi");
    await app.terminal.waitText("Statuses set");
    await app.terminal.waitText("ctx 7%");
    const screen = await app.capture(`footer-${cols}`);
    const [place, budget] = screen.split("\n").slice(-2);
    assert.ok(place?.includes(`${glyphs.branch} ${BRANCH}`), `branch cut:\n${screen}`);
    assert.ok(!place?.includes("fake"), `the session's name outlasted the room:\n${screen}`);
    assert.match(budget ?? "", re`ctx 7% . ${glyphs.card} `, `a figure was cut:\n${screen}`);
    assert.ok(!budget?.includes("medium"), `the thinking level outlasted the room:\n${screen}`);
    await app.close();
  });
}

test("a wide terminal holds everything on one row", async () => {
  const app = await launch({ scenario: "statuses", cols: 160 });
  await app.terminal.submit("hi");
  await app.terminal.waitText("Statuses set");
  await app.terminal.waitText(`${glyphs.mcp} 1/2`);
  const screen = await app.capture("footer-wide");
  const footer = screen.split("\n").at(-1) ?? "";
  assert.ok(
    footer.includes(`${glyphs.session} fake`) &&
      footer.includes(glyphs.agents) &&
      footer.includes("fake-model-1"),
    `split over rows:\n${screen}`,
  );
  await app.close();
});

for (const [name, closes, opens, inner] of [
  ["arrow", "\u{e0b0}", "\u{e0b2}", "\u{e0b1}"],
  ["slant", "\u{e0bc}", "\u{e0ba}", "\u{e0bb}"],
  ["backslant", "\u{e0b8}", "\u{e0be}", "\u{e0b9}"],
  ["none", null, null, "│"],
  ["gap", null, null, "│"],
] as const) {
  test(`the ${name} separator draws where bands meet and inside them`, async () => {
    const app = await launch({
      scenario: "hello",
      env: { PITUITARY_FOOTER_SEPARATOR: name, PITUITARY_FIRELIGHT: "off" },
    });
    await app.terminal.waitText(glyphs.card);
    await app.capture(`footer-separator-${name}`);
    const cells = (await footerCells(app.terminal)).filter((cell) => cell.row === 27);
    const at = (char: string) => cells.filter((cell) => cell.char === char).map((cell) => [cell.fg, cell.bg]);
    const divider = cells.find((cell) => cell.char === inner);
    assert.deepEqual([divider?.fg, divider?.bg], ["#a89984", INNER]);
    if (closes && opens) {
      assert.deepEqual(at(closes), [
        [OUTER, INNER],
        [INNER, BAR],
      ]);
      assert.deepEqual(at(opens), [
        [INNER, BAR],
        [OUTER, INNER],
        [FIREBOX, OUTER],
      ]);
    } else {
      // The directory's band ends where the branch's begins, directly or across a cell of the bar.
      const end = cells.findIndex((cell) => cell.bg !== OUTER);
      assert.equal(cells[end]?.bg, name === "gap" ? BAR : INNER);
    }
    await app.close();
  });
}

test("plain glyphs set bands edge to edge", async () => {
  const app = await launch({
    scenario: "hello",
    env: { PITUITARY_PLAIN_GLYPHS: "1", PITUITARY_FOOTER_SEPARATOR: "arrow" },
  });
  await app.terminal.waitText("▬");
  const footer = (await app.capture("footer-plain")).split("\n").at(-1) ?? "";
  assert.doesNotMatch(footer, /[\u{e0b0}-\u{e0bf}]/u, footer);
  assert.ok(footer.includes(" ⎇ main │ ◆ fake "), footer);
  await app.close();
});

test("a palette sets every band, and the bar they sit on", async () => {
  const app = await launch({ scenario: "hello", env: { PITUITARY_FOOTER_PALETTE: "peach" } });
  await app.terminal.waitText(glyphs.card);
  await app.capture("footer-palette-peach");
  const cells = (await footerCells(app.terminal)).filter((cell) => cell.row === 27);
  assert.equal(cells[0]?.bg, "#fccd8f");
  assert.equal(cells[50]?.bg, "#fbf1c7");
  await app.close();
});

for (const hearth of [8, 12]) {
  test(`the hearth gives the fire a slot ${hearth} cells wide at the footer's end`, async () => {
    const app = await launch({
      scenario: "hello",
      env: {
        PITUITARY_FIRELIGHT: "off",
        ...(hearth === 8 ? {} : { PITUITARY_FOOTER_HEARTH: String(hearth) }),
      },
    });
    await app.terminal.waitText(glyphs.card);
    await app.capture(`footer-hearth-${hearth}`);
    const cells = (await footerCells(app.terminal)).filter((cell) => cell.row === 27);
    const into = cells.findLastIndex((cell) => cell.char === "\u{e0b2}");
    assert.equal(into, 99 - hearth);
    assert.deepEqual([cells[into]?.fg, cells[into]?.bg], [FIREBOX, OUTER]);
    const fire = cells.slice(into + 1);
    assert.equal(fire.length, hearth);
    assert.ok(
      fire.every((cell) => cell.char !== " " || cell.bg !== BAR),
      `the hearth holds the bar:\n${JSON.stringify(fire)}`,
    );
    await app.close();
  });
}

test("a retry counts down and escape cancels it", async () => {
  const app = await launch({ scenario: "retry-wait" });
  await app.terminal.submit("go");
  await app.terminal.waitText("retrying 1/3 in");
  const screen = await app.capture("retrying");
  assert.match(
    screen,
    re`${glyphs.retrying} retrying 1/3 in \d+s · esc esc cancels · 529 overloaded_error`,
    screen,
  );
  await normalMode(app.terminal);
  await app.terminal.keyboard.press("Escape");
  await app.terminal.waitText("retrying", { not: true });
  await app.close();
});

test("the model's provider mark draws in its brand colour beside the model's name", async () => {
  const app = await launch({ scenario: "providers" });
  await app.terminal.waitText(`${glyphs.anthropic} Sonnet 4.5`);
  await app.capture("footer-provider");
  const cells = await footerCells(app.terminal);
  const mark = cells.findIndex((cell) => cell.char === glyphs.anthropic);
  assert.equal(cells[mark]?.fg, TERRA_COTTA);
  assert.equal(cells[mark + 2]?.char, "S");
  assert.equal(cells[mark + 2]?.fg, ORANGE);
  await app.close();
});

test("the plain provider mark keeps its brand colour", async () => {
  const app = await launch({ scenario: "providers", env: { PITUITARY_PLAIN_GLYPHS: "1" } });
  await app.terminal.waitText("✳ Sonnet 4.5");
  assert.equal(await colourOf(app.terminal, "✳"), TERRA_COTTA);
  await app.close();
});
