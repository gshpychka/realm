import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

after(async () => {
  await closeAll();
});

test("renders the chrome and the empty conversation", async () => {
  const app = await launch();
  const screen = await app.capture("empty");
  assert.ok(screen.includes(`fake-model-1 ${glyphs.thinking} medium`), `footer missing:\n${screen}`);
  assert.match(screen, /Ask pi something to get started/, `placeholder missing:\n${screen}`);
  assert.match(screen, re` ctx \d+% . ${glyphs.card} `, `context use missing:\n${screen}`);
  await app.close();
});
