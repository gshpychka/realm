import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { palette, theme } from "../packages/tui/src/theme.ts";
import { launch, RUNNING, waitMatch } from "./helpers/harness.ts";

const COLS = 140;
const ROWS = 28;

/** The corner fire burns in the hearth, the footer's last eight columns. */
const HEARTH = 8;
const FIRE_LEFT = COLS - HEARTH;

/** The model band's fill, which the separator into the hearth sits on. */
const BAND = "#504945";

after(async () => {
  await closeAll();
});

interface Cell {
  char: string;
  fg: string;
  bg: string;
}

async function cellAt(terminal: TuiTest, x: number, y: number): Promise<Cell> {
  const [cell] = await terminal.cells(x, y, 1, 1);
  return { char: String(cell?.char), fg: String(cell?.fg), bg: String(cell?.bg) };
}

/**
 * What lies nearest the corner fire: the thinking level's last letter, across the model band's
 * padding and the separator into the hearth; that padding, a fill; and the rule above the fire's middle.
 */
async function besideCorner(terminal: TuiTest): Promise<{ text: Cell; rule: Cell; fill: Cell }> {
  return {
    text: await cellAt(terminal, FIRE_LEFT - 3, ROWS - 1),
    rule: await cellAt(terminal, FIRE_LEFT + HEARTH / 2, ROWS - 2),
    fill: await cellAt(terminal, FIRE_LEFT - 2, ROWS - 1),
  };
}

const red = (colour: string) => Number.parseInt(colour.slice(1, 3), 16);

async function idle(env: Record<string, string> = {}) {
  const app = await launch({ scenario: "hello", cols: COLS, env });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  return app;
}

test("the corner fire lights the text beside it, warming its red, and leaves the fills alone", async () => {
  const app = await idle();
  const screen = await app.capture("firelight");
  const { text, rule, fill } = await besideCorner(app.terminal);
  assert.equal(text.char, "m", screen);
  assert.ok(red(text.fg) > red(palette.muted), `the text beside the fire is unlit: ${text.fg}`);
  assert.equal(rule.char, "━", screen);
  assert.ok(red(rule.fg) > red(theme.border), `the rule above the fire is unlit: ${rule.fg}`);
  assert.equal(text.bg, BAND);
  assert.equal(fill.bg, BAND);
  await app.close();
});

test("the light on the text beside a burning fire rises and falls with its heat", async () => {
  const app = await launch({ scenario: "hello", cols: COLS, settle: false, env: { PITUITARY_STILL: "0" } });
  await app.terminal.waitText("fake-model-1");
  const seen = new Set<string>();
  for (let sample = 0; sample < 8; sample++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const { rule } = await besideCorner(app.terminal);
    assert.ok(red(rule.fg) > red(theme.border), `an unlit reading: ${rule.fg}`);
    seen.add(rule.fg);
  }
  assert.ok(seen.size > 1, `the light held still: ${[...seen].join(" ")}`);
  await app.close();
});

test("with firelight off the text beside the fire keeps its own colour", async () => {
  const app = await idle({ PITUITARY_FIRELIGHT: "off" });
  await app.capture("firelight-off");
  const { text, rule, fill } = await besideCorner(app.terminal);
  assert.equal(text.fg, palette.muted);
  assert.equal(rule.fg, theme.border);
  assert.equal(fill.bg, BAND);
  await app.close();
});

test("the light goes with the fire to the working line, leaving a bare corner unlit", async () => {
  const bare = {
    PITUITARY_FIRE_COALS: "none",
    PITUITARY_FIRE_SMOKE: "0",
    PITUITARY_FIRE_SPARKS: "0",
    PITUITARY_FIRE_WARMTH: "none",
  };
  const app = await launch({ scenario: "long", delayMs: 80, cols: COLS, env: bare });
  await app.terminal.submit("go");
  await waitMatch(app.terminal, RUNNING);
  // Lets the frame in flight arrive whole.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const screen = await app.capture("firelight-working");
  const { text, rule } = await besideCorner(app.terminal);
  assert.equal(text.fg, palette.muted, `the corner is still lit:\n${screen}`);
  assert.equal(rule.fg, theme.border, `the corner is still lit:\n${screen}`);
  const row = screen.split("\n").findIndex((line) => RUNNING.test(line));
  // The working line's icon, two columns right of its five-column fire.
  const icon = await cellAt(app.terminal, 7, row);
  assert.notEqual(icon.char.trim(), "", screen);
  assert.ok(red(icon.fg) > red(palette.muted), `the text beside the working fire is unlit: ${icon.fg}`);
  assert.equal(icon.bg, theme.bg);
  await app.close();
});
