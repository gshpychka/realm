import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { click, drag, launch } from "./helpers/harness.ts";

const COLS = 100;

/** The fire lights the cells around it; a test that reads backgrounds reads them by their own light. */
const UNLIT = { PITUITARY_FIRELIGHT: "off" };

after(async () => {
  await closeAll();
});

/** Drags across `text` on the screen; true when the drag left any of that row highlighted. */
async function selects(terminal: TuiTest, text: string): Promise<boolean> {
  const lines = (await terminal.text()).split("\n");
  const row = lines.findIndex((line) => line.includes(text));
  assert.ok(row >= 0, `"${text}" is not on the screen`);
  const col = lines[row]?.indexOf(text) ?? 0;
  const before = await terminal.cells(0, row, COLS, 1);
  await drag(terminal, row, col, col + text.length - 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await terminal.cells(0, row, COLS, 1);
  return after.some((cell, index) => cell.bg !== before[index]?.bg);
}

test("a drag selects the prompt, the reply, and the tool's call and output, and nothing around them", async () => {
  const app = await launch({ scenario: "tool", env: UNLIT });
  await app.terminal.submit("go");
  await app.terminal.waitText("Three entries at the root.");
  const lines = (await app.terminal.text()).split("\n");
  await click(
    app.terminal,
    2,
    lines.findIndex((line) => line.includes("1 tool")),
  );
  await app.terminal.waitText("╰");
  for (const chrome of ["0s · ", "ask pi · !cmd", "━━━━━━━━", "fake-model-1", "╰──────"]) {
    assert.equal(await selects(app.terminal, chrome), false, `"${chrome}" was selected`);
  }
  const screen = await app.capture("selection-chrome");
  assert.doesNotMatch(screen, /copied/, screen);
  for (const content of ["go", "Listing the directory", "$ ls -1", "flake.nix", "Three entries"]) {
    assert.equal(await selects(app.terminal, content), true, `"${content}" was not selected`);
  }
  await app.terminal.waitText("copied");
  await app.capture("selection-content");
  await app.close();
});
