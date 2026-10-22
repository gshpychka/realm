import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { FIREBOX } from "../packages/tui/src/footer-style.ts";
import { palette } from "../packages/tui/src/theme.ts";
import { bounds, fireCells } from "./helpers/fire.ts";
import { launch, RUNNING, waitMatch } from "./helpers/harness.ts";

const COLS = 140;
const ROWS = 28;

/** The corner: the hearth's eight columns, which end the footer. */
const CORNER_COLUMNS = 8;
const CORNER = COLS - CORNER_COLUMNS;

const COALS = /^[▁▂▃]$/;
const SMOKE = /[░▒▓█]/;
const SPARKS = /[•·]/;

/** Every remains setting off. */
const BARE = {
  PITUITARY_FIRE_COALS: "none",
  PITUITARY_FIRE_SMOKE: "0",
  PITUITARY_FIRE_SPARKS: "0",
  PITUITARY_FIRE_WARMTH: "none",
  PITUITARY_FIRE_PILOT: "off",
  PITUITARY_FIRE_ASH: "off",
};

after(async () => {
  await closeAll();
});

async function corner(terminal: TuiTest) {
  return (await terminal.cells(CORNER, ROWS - 1, CORNER_COLUMNS, 1)).map((cell) => ({
    char: cell.char || " ",
    fg: String(cell.fg),
    bg: String(cell.bg),
  }));
}

/** The two rows above the corner, where smoke and sparks rise, as text. */
async function above(terminal: TuiTest): Promise<string> {
  const cells = await terminal.cells(CORNER, ROWS - 3, CORNER_COLUMNS, 2);
  return cells.map((cell) => cell.char || " ").join("");
}

const channels = (colour: string) => [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));

/** A colour a coal glows: red leading, blue far behind. */
function warm(colour: string): boolean {
  const [r = 0, g = 0, b = 0] = channels(colour);
  return r >= g && r - b >= 0x40;
}

/** Waits for the frame in flight to arrive whole. */
const drawn = () => new Promise((resolve) => setTimeout(resolve, 150));

async function working(env: Record<string, string> = {}, settle = true) {
  const app = await launch({ scenario: "long", delayMs: 80, cols: COLS, env, settle });
  await app.terminal.waitText("fake-model-1");
  await app.terminal.submit("go");
  await waitMatch(app.terminal, RUNNING);
  return app;
}

test("while pi works the corner keeps coals glowing in warm colours", async () => {
  const app = await working();
  await drawn();
  const screen = await app.capture("remains-working");
  const cells = await corner(app.terminal);
  for (const cell of cells) {
    assert.match(cell.char, COALS, `not a coal: ${JSON.stringify(cells)}\n${screen}`);
    assert.ok(warm(cell.fg), `a coal not glowing: ${JSON.stringify(cells)}`);
  }
  // The thinking level's last letter, across the model band's padding and the separator into the
  // hearth, answers their light.
  const [lit] = await app.terminal.cells(CORNER - 3, ROWS - 1, 1, 1);
  assert.equal(lit?.char, "m", screen);
  const red = (colour: unknown) => channels(String(colour))[0] ?? 0;
  assert.ok(red(lit?.fg) > red(palette.muted), `the coals light nothing beside them: ${lit?.fg}`);
  await app.close();
});

test("with every remains setting off the corner is a bare firebox while pi works", async () => {
  const app = await working(BARE);
  await drawn();
  const screen = await app.capture("remains-none");
  for (const cell of await corner(app.terminal)) {
    assert.equal(cell.char, " ", screen);
    assert.equal(cell.bg, FIREBOX, screen);
  }
  const rising = await above(app.terminal);
  assert.doesNotMatch(rising, SMOKE, `smoke above the corner:\n${screen}`);
  assert.doesNotMatch(rising, SPARKS, `sparks above the corner:\n${screen}`);
  await app.close();
});

test("smoke rises above the corner soon after the fire leaves, and never over the coals", async () => {
  const app = await working({ PITUITARY_STILL: "0" }, false);
  const start = performance.now();
  let risen = false;
  while (!risen && performance.now() - start < 3000) {
    risen = SMOKE.test(await above(app.terminal));
    for (const cell of await corner(app.terminal))
      assert.doesNotMatch(cell.char, SMOKE, "smoke over the coals");
    if (!risen) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await app.capture("remains-smoke");
  assert.ok(risen, `no smoke above the corner within 3 s:\n${await app.terminal.text()}`);
  await app.close();
});

test("without smoke nothing grey rises above the corner", async () => {
  const app = await working({ PITUITARY_STILL: "0", PITUITARY_FIRE_SMOKE: "0" }, false);
  const start = performance.now();
  while (performance.now() - start < 2500) {
    assert.doesNotMatch(await above(app.terminal), SMOKE, "smoke rose with PITUITARY_FIRE_SMOKE=0");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await app.capture("remains-no-smoke");
  await app.close();
});

test("a fire that stays keeps to its corner while pi works, and the working line starts where its room was", async () => {
  const app = await working({ PITUITARY_FIRE_TRAVELS: "off" });
  await drawn();
  const screen = await app.capture("remains-stays");
  const box = bounds(await fireCells(app.terminal, COLS, ROWS));
  assert.ok(box, `no fire:\n${screen}`);
  assert.equal(box.bottom, ROWS - 1, `the fire left the corner:\n${screen}`);
  assert.ok(box.left >= CORNER, `the fire left the corner:\n${screen}`);
  const line = screen.split("\n").find((row) => RUNNING.test(row)) ?? "";
  assert.match(line, /^ [^ ▖▗▘▙▚▛▜▝▞▟▀▄▌▐█]/, `the working line keeps room for a fire:\n${screen}`);
  await app.close();
});
