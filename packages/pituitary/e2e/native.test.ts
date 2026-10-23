import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch, pastGrace, settled } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});
test("native coding tools retain readable arguments and output", async () => {
  const app = await launch({ scenario: "tool" });
  try {
    await app.terminal.submit("inspect the workspace");
    await app.terminal.waitText("The workspace inspection is complete.");
    await settled(app.terminal);
    await app.terminal.write("\x0f");
    await app.terminal.waitText("native tool output");
    const screen = await app.capture("native-tools-expanded");
    assert.match(screen, /native tool output/);
    assert.match(screen, /line two/);
    assert.match(screen, /printf/);
  } finally {
    await app.close();
  }
});
test("a local conversation chooses a configured native model before its first prompt", async () => {
  const app = await launch({ env: { PITUITARY_FIXTURE_MODEL: "none" } });
  try {
    await app.terminal.waitText("model");
    await pastGrace();
    const picker = await app.capture("native-first-model");
    assert.match(picker, /faux-1/);
    assert.match(picker, /faux-2/);
    await app.terminal.type("faux-2");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("model: faux/faux-2");
    await app.terminal.submit("continue with this model");
    await app.terminal.waitText("You said: continue with this model");
    await app.capture("native-model-selected");
  } finally {
    await app.close();
  }
});
test("native conversation commands rename and inspect persisted conversation metadata", async () => {
  const app = await launch();
  try {
    await app.terminal.submit("/name A readable conversation");
    await app.terminal.waitText("A readable conversation");
    await app.terminal.submit("/session");
    await app.terminal.waitText("tokens:");
    const screen = await app.capture("native-conversation-info");
    assert.match(screen, /tokens:/);
    assert.doesNotMatch(screen, /not saved|session file/);
  } finally {
    await app.close();
  }
});
