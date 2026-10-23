import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

test("renders the chrome and the empty conversation", async () => {
  const app = await launch();
  const screen = await app.capture("empty");
  assert.ok(screen.includes(`faux-1`), `footer missing:\n${screen}`);
  assert.match(screen, /Ask pi something to get started/, `placeholder missing:\n${screen}`);
  await app.close();
});
