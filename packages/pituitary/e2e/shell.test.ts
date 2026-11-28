import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

test("! runs a shell command whose output goes with the next prompt; !! keeps it out; the interrupt stops one", async () => {
  const app = await launchPi();
  try {
    await app.terminal.type("!echo hello from the shell");
    await app.terminal.waitText("!echo hello from the shell");
    await app.terminal.waitIdle();
    await app.capture("shell-draft");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /^ +hello from the shell\s*$/m);
    await app.terminal.waitIdle();
    const ran = await app.capture("shell-ran");
    assert.match(ran, /▌ \$ echo hello from the shell/);
    assert.doesNotMatch(ran, /no output/);

    await app.terminal.submit("!!echo kept from the model");
    await app.terminal.waitText("not in pi's context");
    await app.terminal.submit("!exit 3");
    await app.terminal.waitText("✗ exit 3");
    await app.terminal.waitIdle();
    await app.capture("shell-excluded-and-failed");
    // Nothing went to the model yet: Pi sends the output with the next prompt.
    assert.equal(app.provider.requests.length, 0);

    await app.terminal.submit("what did it say");
    await app.terminal.waitText("Reply to: what did it say");
    await app.terminal.waitIdle();
    const body = JSON.stringify(app.provider.requests.at(-1)?.body);
    assert.match(body, /hello from the shell/);
    assert.doesNotMatch(body, /kept from the model/);

    // A long output keeps its latest lines, half the screen's 28 rows, until ctrl+o.
    await app.terminal.submit("!seq 1 30");
    await app.terminal.waitText("… 16 earlier lines · ctrl+o");
    await app.terminal.waitIdle();
    const long = await app.capture("shell-long");
    assert.match(long, /earlier lines · ctrl\+o\n {3}17\n {3}18\n/);
    assert.match(long, /^ {3}30\b/m);
    await app.terminal.write("\x0f");
    await waitMatch(app.terminal, /^(?![\s\S]*earlier lines)/);
    await app.terminal.write("\x0f");
    await app.terminal.waitText("… 16 earlier lines · ctrl+o");

    await app.terminal.submit("!echo started; sleep 30");
    await app.terminal.waitText("◌ running · esc esc stops");
    await app.terminal.waitText("started");
    await app.capture("shell-running");
    // As in Pi, one command runs at a time; the draft keeps the one that waits.
    await app.terminal.submit("!echo second");
    await app.terminal.waitText("a shell command is already running · stop it first");
    await waitMatch(app.terminal, /» !echo second/);
    await app.terminal.keyboard.press("Escape");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("cancelled");
    await app.terminal.waitIdle();
    const stopped = await app.capture("shell-stopped");
    assert.doesNotMatch(stopped, /◌ running/);
  } finally {
    await app.close();
  }
});
