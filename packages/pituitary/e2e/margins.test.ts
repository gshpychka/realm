import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch, waitMatch } from "./helpers/harness.ts";

const WORDS = "Amber birch cedar dogwood elm fir ginkgo hazel ivy juniper";
const NARROW = { cols: 44, rows: 28, env: { PITUITARY_FIRELIGHT: "off" } };

after(async () => {
  await closeAll();
});

test("a wrapped reply stays in its body's column beside its mark", async () => {
  const app = await launch({ ...NARROW, scenario: "hello" });
  try {
    await app.terminal.submit(WORDS);
    await app.terminal.waitText("You said:");
    const screen = await app.capture("margins-reply");
    const lines = screen.split("\n");
    const row = lines.findIndex((line) => line.includes("You said:"));
    assert.match(lines[row] ?? "", /^ ● You said:/, screen);
    assert.match(lines[row + 1] ?? "", /^ {3}fir ginkgo hazel ivy juniper$/, screen);
  } finally {
    await app.close();
  }
});

test("a long reply remains visible after narrowing the terminal", async () => {
  const app = await launch({ ...NARROW, scenario: "long" });
  try {
    await app.terminal.submit("go");
    await app.terminal.waitText("line 40 of the long answer");
    await app.terminal.resize(30, NARROW.rows);
    await waitMatch(app.terminal, / {3}line 40 of the long\n {3}answer/);
    const screen = await app.capture("margins-long-narrow");
    assert.match(screen, / {3}line 40 of the long\n {3}answer/, screen);
  } finally {
    await app.close();
  }
});
