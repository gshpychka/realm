import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { cellsOf, RUNNING, waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const SHIFT_TAB = "\x1b[Z";

test("! runs a shell command whose output goes with the next prompt; !! keeps it out; the interrupt stops one", async () => {
  const app = await launchPi();
  try {
    await app.terminal.type("!echo hello from the shell");
    await app.terminal.waitText("!echo hello from the shell");
    await app.terminal.waitIdle();
    await app.capture("shell-draft");
    // The leading mark shows as a chip, set apart from the command after it.
    const [mark, command] = await cellsOf(app.terminal, "!e");
    assert.notDeepEqual(mark?.bg, command?.bg);
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

    // One line longer than the screen is wide takes the rows it wraps to out of the same half.
    await app.terminal.submit("!printf 'y%.0s' $(seq 1 3000); echo; echo LASTLINE");
    await waitMatch(app.terminal, /^ +LASTLINE\b/m);
    await app.terminal.waitIdle();
    const wide = await app.capture("shell-long-line");
    const rows = wide.split("\n").filter((line) => /^ +y{20,}/.test(line)).length;
    assert.ok(rows > 0 && rows < 14, `${rows} rows of the long line:\n${wide}`);
    assert.match(wide, /earlier lines · ctrl\+o\n( +y+.*\n)+ +LASTLINE/);

    // Pi keeps only the end of a longer output, and says where the whole of it is.
    await app.terminal.submit("!seq 1 5000");
    await waitMatch(app.terminal, /^ +5000\b/m);
    await app.terminal.waitIdle();
    const truncated = await app.capture("shell-truncated");
    assert.match(truncated, /Pi kept only the last 2000 lines · full output below/);
    assert.match(truncated, /full output: \S+/);

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
    // Once the command has stopped, nothing says it still runs.
    assert.doesNotMatch(stopped, /already running/);
  } finally {
    await app.close();
  }
});

test("a command run while Pi works stays in view until Pi records it, stops once the run has, and one Pi cannot run keeps its reason", async () => {
  const app = await launchPi();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    app.provider.reply({ text: "never shown", until: held });
    await app.terminal.submit("start a run");
    await waitMatch(app.terminal, RUNNING);
    await app.terminal.submit("!echo midrun-output-marker");
    await waitMatch(app.terminal, /^ +midrun-output-marker\s*$/m);
    // Cycling the thinking level reads the session again, which records the command only as the run ends.
    await app.terminal.write(SHIFT_TAB);
    await app.terminal.waitText("thinking: ");
    assert.match(await app.capture("shell-during-run"), /^ +midrun-output-marker\s*$/m);

    // The interrupt stops the run first, so a command beside it offers no key until then.
    await app.terminal.submit("!echo slow; sleep 30");
    await waitMatch(app.terminal, /^ +slow\s*$/m);
    await app.terminal.waitText("◌ running");
    await app.terminal.waitText("esc esc interrupts");
    const beside = await app.capture("shell-beside-run");
    assert.doesNotMatch(beside, /◌ running · /);
    assert.match(beside, /esc esc interrupts/);
    await app.terminal.keyboard.press("Escape");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("◌ running · esc stops");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("cancelled");
    assert.match(await app.terminal.text(), /^ +midrun-output-marker\s*$/m);

    await app.terminal.write("i");
    await app.terminal.submit('!rm -rf "$PWD" && echo removed-cwd');
    await waitMatch(app.terminal, /^ +removed-cwd\s*$/m);
    await app.terminal.submit("!echo after-removal");
    await app.terminal.waitText("Working directory does not exist");
    // Pi records nothing of a command it cannot run, and reading the session again keeps it.
    await waitMatch(app.terminal, /^(?![\s\S]*thinking: )/);
    await app.terminal.write(SHIFT_TAB);
    await app.terminal.waitText("thinking: ");
    await app.terminal.waitIdle();
    const refused = await app.capture("shell-not-run");
    assert.match(refused, /▌ \$ echo after-removal\n {3}✗ Working directory does not exist/);
  } finally {
    release();
    await app.close();
  }
});
