import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import {
  drag,
  type Launched,
  launch,
  NORMAL,
  normalMode,
  RUNNING,
  settled,
  survivors,
  uiPid,
  waitMatch,
} from "./helpers/harness.ts";
import { hasTerminal } from "./helpers/processes.ts";

const CTRL_J = "\n";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SELECTION = "#665c54";

/** Sixty numbered words: one paragraph that wraps onto several rows. */
const PARAGRAPH = Array.from({ length: 60 }, (_, index) => `word${String(index).padStart(2, "0")}`).join(" ");

after(async () => {
  await closeAll();
});

/** The draft's rows: between the rules above and below it. */
function draftRows(screen: string): string[] {
  const lines = screen.split("\n");
  const below = lines.findLastIndex((line) => /^━+$/.test(line.trim()));
  const above = lines.slice(0, below).findLastIndex((line) => /^━+$/.test(line.trim()));
  return lines.slice(above + 1, below);
}

/** Resolves with the cursor once it stands where `want` says. */
async function cursorAt(app: Launched, want: { x?: number; y?: number }): Promise<{ x: number; y: number }> {
  const start = Date.now();
  for (;;) {
    const cursor = await app.terminal.getCursor();
    if ((want.x ?? cursor.x) === cursor.x && (want.y ?? cursor.y) === cursor.y) return cursor;
    if (Date.now() - start > 2000) {
      throw new Error(`the cursor stayed at ${JSON.stringify(cursor)}, not ${JSON.stringify(want)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the embedded nvim holds no terminal, so a check for a running vim passes the UI over", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("x");
  await app.terminal.waitText("» x");
  const nvim = survivors(app.home).filter((line) => /^\d+ \S*nvim /.test(line));
  assert.notEqual(nvim.length, 0, "no nvim runs");
  assert.ok(hasTerminal(uiPid(app.home)), "the UI holds no terminal");
  for (const line of nvim) assert.ok(!hasTerminal(Number(line.split(" ")[0])), line);
  await app.close();
});

test("the draft starts in insert mode and escape moves it to normal mode", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type('say "hi there" now');
  await app.terminal.waitText('» say "hi there" now');
  await normalMode(app.terminal);
  const screen = await app.capture("vim-normal");
  assert.match(screen, /^ N say "hi there" now/m, screen);
  await app.close();
});

test('ci" changes the quoted words, and u takes the change back', async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type('say "hi there" now');
  await app.terminal.waitText('» say "hi there" now');
  await normalMode(app.terminal);
  await app.terminal.type('0wci"yo');
  await app.terminal.waitText('» say "yo" now');
  await normalMode(app.terminal);
  await app.capture("vim-change-inner");
  await app.terminal.type("u");
  await waitMatch(app.terminal, /^ N say "hi there" now/m);
  await app.terminal.type("0dw");
  const screen = await waitMatch(app.terminal, /^ N "hi there" now/m);
  assert.doesNotMatch(screen, /say/, screen);
  await app.close();
});

test("a visual selection is drawn in the selection colour", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("select these words");
  await app.terminal.waitText("» select these words");
  await normalMode(app.terminal);
  await app.terminal.type("0vll");
  const screen = await waitMatch(app.terminal, /^ V select these words/m);
  const row = screen.split("\n").findIndex((line) => line.startsWith(" V select"));
  // The cursor marks the selection's last character, which nvim leaves out of the selection's colour.
  await cursorAt(app, { x: 5, y: row });
  await app.capture("vim-visual");
  const cells = await app.terminal.cells(0, row, 20, 1);
  const selected = cells
    .filter((cell) => cell.bg === SELECTION)
    .map((cell) => cell.char)
    .join("");
  assert.equal(selected, "se", JSON.stringify(cells.slice(0, 8)));
  await app.close();
});

test("the draft grows with its lines and returns to one row once sent", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("first line");
  await app.terminal.write(CTRL_J);
  await app.terminal.type("x".repeat(150));
  await app.terminal.write(CTRL_J);
  await app.terminal.type("last line");
  await app.terminal.waitText("last line");
  const grown = await app.capture("vim-grown");
  assert.equal(draftRows(grown).length, 4, grown);
  await app.terminal.submit();
  await app.terminal.waitText("You said: first line");
  const sent = await app.capture("vim-sent");
  assert.equal(draftRows(sent).length, 1, sent);
  assert.match(sent, /^ » ask pi/m, sent);
  await app.close();
});

test("the draft scrolls a row at a time, and holds still while the cursor moves inside it", async () => {
  const app = await launch({ scenario: "hello" });
  for (let line = 1; line <= 12; line++) {
    if (line > 1) await app.terminal.write(CTRL_J);
    await app.terminal.type(`line ${line}`);
  }
  await app.terminal.waitText("line 12");
  const screen = await app.terminal.text();
  assert.match(draftRows(screen)[0] ?? "", /line 5$/, screen);
  const top = screen.split("\n").indexOf(draftRows(screen)[0] ?? "");
  for (let step = 0; step < 7; step++) await app.terminal.write(UP);
  // The cursor reaches the top row while the view stays where it is.
  await cursorAt(app, { y: top });
  assert.equal(draftRows(await app.terminal.text())[0], " » line 5");
  await app.terminal.write(UP);
  await waitMatch(app.terminal, /^ » line 4$/m);
  const scrolled = await app.capture("vim-scrolled");
  const rows = draftRows(scrolled);
  assert.deepEqual(
    rows.map((row) => row.trim().replace(/^» /, "")),
    Array.from({ length: 8 }, (_, index) => `line ${index + 4}`),
    scrolled,
  );
  assert.equal((await app.terminal.getCursor()).y, top, "the cursor left the top row");
  await app.terminal.write(DOWN);
  await app.terminal.write(DOWN);
  await app.terminal.type("X");
  const moved = await waitMatch(app.terminal, /line 6X/);
  assert.equal(draftRows(moved)[0], " » line 4", moved);
  await app.close();
});

test("a long line wraps between words", async () => {
  const app = await launch({ scenario: "hello", cols: 38 });
  const words = "a long line of words wraps onto the next row between two of them, never inside one";
  await app.terminal.type(words);
  await app.terminal.waitText("inside one");
  const screen = await app.capture("vim-word-wrap");
  const rows = draftRows(screen).map((row) => row.slice(3).trimEnd());
  assert.ok(rows.length > 1, screen);
  assert.equal(rows.join(" "), words, screen);
  await app.close();
});

test("up walks a wrapped paragraph a row at a time, and leaves it only when asked twice at the top", async () => {
  const app = await launch({ scenario: "hello", cols: 60 });
  await app.terminal.submit("earlier");
  await app.terminal.waitText("You said: earlier");
  await app.terminal.type(PARAGRAPH);
  await app.terminal.waitText("word59");
  const typed = await app.capture("vim-paragraph");
  const rows = draftRows(typed);
  assert.ok(rows.length >= 3, typed);
  // Every character shows, none lost where a row wraps; the screen's text drops a row's trailing space.
  const shown = rows.map((row) => row.slice(3).padEnd(60 - 4)).join("");
  assert.equal(shown.trimEnd(), PARAGRAPH, typed);
  const start = await app.terminal.getCursor();
  for (let step = 1; step < rows.length; step++) {
    await app.terminal.write(UP);
    const cursor = await cursorAt(app, { y: start.y - step });
    assert.equal(cursor.x, start.x, `up ${step} drifted across`);
  }
  const top = await app.terminal.text();
  assert.doesNotMatch(top, /↑ again/, top);
  await app.terminal.write(UP);
  await app.terminal.waitText("↑ again for the previous prompt");
  assert.match(await app.terminal.text(), /word59/);
  await app.terminal.write(UP);
  await waitMatch(app.terminal, /^ » earlier$/m);
  await app.close();
});

test("enter sends from normal mode, and the next draft starts in insert mode", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("from normal");
  await app.terminal.waitText("» from normal");
  await normalMode(app.terminal);
  await app.terminal.submit();
  await app.terminal.waitText("You said: from normal");
  await app.terminal.type("next");
  await app.terminal.waitText("» next");
  await app.close();
});

test("escape in normal mode interrupts a running reply", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await normalMode(app.terminal);
  const normal = await app.terminal.text();
  assert.match(normal, RUNNING, `the first escape interrupted:\n${normal}`);
  await app.terminal.keyboard.press("Escape");
  await settled(app.terminal);
  const screen = await app.capture("vim-interrupted");
  assert.match(screen, /aborted/, screen);
  await app.close();
});

test("the terminal cursor sits at the insertion point", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("abc");
  const screen = await app.terminal.waitText("» abc").then(() => app.terminal.text());
  const row = screen.split("\n").findIndex((line) => line.startsWith(" » abc"));
  await waitMatch(app.terminal, /» abc/);
  const cursor = await app.terminal.getCursor();
  assert.deepEqual(cursor, { x: 6, y: row });
  await normalMode(app.terminal);
  await app.terminal.type("0");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await app.terminal.getCursor(), { x: 3, y: row });
  await app.close();
});

test("a paste lands whole, in insert or normal mode", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.write("\x1b[200~line one\nline two\x1b[201~");
  await app.terminal.waitText("line two");
  const screen = await app.terminal.text();
  assert.deepEqual(draftRows(screen), [" » line one", "   line two"], screen);
  assert.doesNotMatch(screen, NORMAL, screen);
  await app.close();
});

test("with no nvim to run, a plain editor takes over and says so", async () => {
  const app = await launch({ scenario: "hello", env: { PITUITARY_NVIM: "/nonexistent/nvim" } });
  await app.terminal.waitText("vim mode is off");
  await app.terminal.submit("still works");
  await app.terminal.waitText("You said: still works");
  await app.capture("vim-fallback");
  await app.close();
});

test("the hints name the escapes the interrupt takes from where the draft stands", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await waitMatch(app.terminal, /esc esc +leave insert mode, then interrupt/);
  await app.terminal.submit("write a lot");
  await waitMatch(app.terminal, / · \d+s · esc esc interrupts/);
  await normalMode(app.terminal);
  const screen = await waitMatch(app.terminal, / · \d+s · esc interrupts/);
  await app.capture("vim-hint-normal");
  assert.doesNotMatch(screen, /esc esc interrupts/, screen);
  await app.close();
});

test("a pending count takes escape, and the next escape interrupts", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.type("abcdef");
  await app.terminal.waitText(`${glyphs.steering} abcdef`);
  await normalMode(app.terminal);
  await app.terminal.write("0");
  await app.terminal.write("3");
  await waitMatch(app.terminal, / · \d+s · esc esc interrupts/);
  await app.terminal.keyboard.press("Escape");
  await waitMatch(app.terminal, / · \d+s · esc interrupts/);
  // The count is gone, so x takes one character, not three.
  await app.terminal.write("x");
  const edited = await waitMatch(app.terminal, /^ N bcdef/m);
  assert.match(edited, RUNNING, `the escape on the count interrupted:\n${edited}`);
  await app.terminal.keyboard.press("Escape");
  await settled(app.terminal);
  await app.close();
});

test("ctrl+v then enter puts a literal return in the draft and sends nothing", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("ab");
  await app.terminal.waitText("» ab");
  await app.terminal.write("\x16\r");
  const literal = await app.terminal.waitText("» ab^M").then(() => app.terminal.text());
  await app.capture("vim-literal");
  assert.doesNotMatch(literal, /You said/, literal);
  await app.terminal.write("\x16\x1b[A");
  await app.terminal.waitText("» ab^M");
  await app.terminal.submit();
  await app.terminal.waitText("You said: ab");
  const sent = await app.terminal.text();
  assert.ok(!sent.includes("\x1c"), sent);
  await app.close();
});

test("dragging across the draft selects its text and copies it", async () => {
  // The fire lights the cells around it; this test reads backgrounds by their own light.
  const app = await launch({ scenario: "hello", env: { PITUITARY_FIRELIGHT: "off" } });
  await app.terminal.type("draft words here");
  await app.terminal.waitText("» draft words here");
  const row = (await app.terminal.text()).split("\n").findIndex((line) => line.startsWith(" » draft"));
  const before = await app.terminal.cells(0, row, 40, 1);
  await drag(app.terminal, row, 3, 39);
  await app.terminal.waitText("copied");
  const after = await app.terminal.cells(0, row, 40, 1);
  const taken = after.filter((cell, index) => cell.bg !== before[index]?.bg).map((cell) => cell.char);
  assert.equal(taken.join(""), "draft words here");
  await app.close();
});

test("normal mode keeps : and / from opening nvim's command line, and f/ still finds a slash", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("a/b:c");
  await app.terminal.waitText("» a/b:c");
  await normalMode(app.terminal);
  await app.terminal.write("0");
  await app.terminal.write(":");
  await app.terminal.write("/");
  await app.terminal.write("?");
  // Nothing is left half-typed: x deletes the first character.
  await app.terminal.write("x");
  const screen = await waitMatch(app.terminal, /^ N \/b:c$/m);
  await app.capture("vim-no-cmdline");
  assert.doesNotMatch(screen, /^ {3}[:/?]/m, screen);
  await app.terminal.write("f:x");
  await waitMatch(app.terminal, /^ N \/bc$/m);
  await app.terminal.write("0f/x");
  await waitMatch(app.terminal, /^ N bc$/m);
  await app.close();
});

test("/ in normal mode on an empty draft opens the command palette", async () => {
  const app = await launch({ scenario: "hello" });
  await normalMode(app.terminal);
  await app.terminal.write("/");
  await app.terminal.waitText("/model [provider/id]");
  const screen = await app.capture("vim-slash-palette");
  assert.match(screen, /^ » \/$/m, screen);
  await app.close();
});
