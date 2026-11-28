import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { launch, pastGrace, settled, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

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
    await app.terminal.waitText("model: Faux Fast · faux/faux-2");
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
test("a refused credential in a Dura conversation says so, and offers no /login, which only regular Pi has", async () => {
  const app = await launch({ scenario: "refused" });
  try {
    await app.terminal.submit("hello");
    await app.terminal.waitText("invalid x-api-key");
    await settled(app.terminal);
    const refused = await app.capture("native-refused");
    assert.match(refused, /^ \S+ 401:? invalid x-api-key · ctrl\+o$/m);
    assert.doesNotMatch(refused, /\/login/);
  } finally {
    await app.close();
  }
});
test("a reply cut at the model's output limit says so and what to do, with words of its own or none", async () => {
  const app = await launch({ scenario: "cut" });
  try {
    const note = "the reply reached the output limit and stopped · ask it to continue";
    await app.terminal.submit("answer briefly");
    await app.terminal.waitText(note);
    await settled(app.terminal);
    assert.match(await app.capture("native-cut-words"), re`partial answer[\s\S]*${note}`);
    await app.terminal.submit("think it over");
    await waitMatch(app.terminal, re`think it over[\s\S]*${note}`);
    await settled(app.terminal);
    const thought = await app.capture("native-cut-thinking");
    // The note follows the box of work and the latest steps it keeps until the next prompt, with
    // no empty reply before it.
    assert.match(thought, re`▌ think it over\n\n ▸ [^\n]+(\n {3}[^\n]+)*\n\n [^\n]*${note}`);
  } finally {
    await app.close();
  }
});
