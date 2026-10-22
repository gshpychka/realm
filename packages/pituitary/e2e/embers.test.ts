import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { flames, RISE } from "./helpers/fire.ts";
import { launch, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const ROWS = 28;

after(async () => {
  await closeAll();
});

/** The flames in the footer's corner: those on its last row, right of its middle. */
async function hearth(terminal: TuiTest, cols: number): Promise<[number, number][]> {
  return (await flames(terminal, cols, ROWS - 1)).filter(([column]) => column > cols / 2);
}

test("embers smoulder in the lower right corner when the footer has room", async () => {
  const app = await launch({ scenario: "hello", cols: 140 });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  const screen = await app.capture("embers");
  assert.ok((await hearth(app.terminal, 140)).length > 0, `no fire in the corner:\n${screen}`);
  await app.close();
});

test("a footer without room for the narrowest hearth lets the fire go before a figure or the model", async () => {
  const app = await launch({ scenario: "hello", cols: 30 });
  await app.terminal.submit("hi");
  await app.terminal.waitText("ctx 7%");
  const screen = await app.capture("embers-narrow");
  const last = screen.split("\n").at(-1) ?? "";
  const kept = re`ctx 7% . ${glyphs.card} . ${glyphs.model} fake-model-1\s*$`;
  assert.match(last, kept, `a figure or the model lost:\n${last}`);
  assert.deepEqual(await hearth(app.terminal, 30), [], `fire kept at 30 columns:\n${last}`);
  await app.close();
});

test("the embers move slowly, and nothing else in the footer does", async () => {
  const app = await launch({ scenario: "hello", cols: 140, settle: false, env: { PITUITARY_STILL: "0" } });
  // The context band arrives with the session's stats, after the model; until then the footer still fills in.
  await waitMatch(app.terminal, /ctx \d+%.*fake-model-1/);
  const frames = await app.film("embers-motion", 6, 300);
  const rows = frames.map((frame) => [...(frame.split("\n").at(-1) ?? "")]);
  const moved = (rows[0] ?? []).flatMap((_, column) =>
    new Set(rows.map((row) => row[column])).size > 1 ? [column] : [],
  );
  assert.ok(
    moved.length > 0,
    `the fire held still:\n${frames.map((frame) => frame.split("\n").at(-1)).join("\n")}`,
  );
  for (const column of moved) {
    const seen = rows.map((row) => row[column] ?? "");
    assert.ok(
      seen.every((char) => char === " " || RISE.includes(char)),
      `column ${column} of the footer moved: ${seen.join("")}`,
    );
  }
  await app.close();
});

test("the corner fire rises and falls over a few seconds while it burns", async () => {
  const app = await launch({ scenario: "hello", cols: 140, settle: false, env: { PITUITARY_STILL: "0" } });
  await app.terminal.waitText("fake-model-1");
  const tallest = new Set<number>();
  const totals = new Set<number>();
  for (let sample = 0; sample < 15; sample++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lit = await hearth(app.terminal, 140);
    assert.ok(lit.length > 0, "the corner fire went out");
    tallest.add(Math.max(...lit.map(([, height]) => height)));
    totals.add(lit.reduce((sum, [, height]) => sum + height, 0));
  }
  await app.capture("embers-burning");
  assert.ok(tallest.size > 1, `the tallest flame held one height: ${[...tallest].join(" ")}`);
  assert.ok(totals.size > 2, `the fire's height barely changed: ${[...totals].join(" ")}`);
  await app.close();
});
