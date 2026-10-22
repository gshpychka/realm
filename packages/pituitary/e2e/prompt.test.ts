import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch, RUNNING } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

test("shows the prompt and the streamed answer", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("what is 2 + 2");
  await app.terminal.waitText("You said");
  const screen = await app.capture("answer");
  assert.match(screen, /▌ what is 2 \+ 2/, `prompt echo missing:\n${screen}`);
  assert.match(screen, /You said: what is 2 \+ 2/, `answer missing:\n${screen}`);
  assert.doesNotMatch(screen, RUNNING, `status did not settle:\n${screen}`);
  await app.close();
});
