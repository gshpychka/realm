import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { cellsOf, RUNNING, waitMatch } from "./helpers/harness.ts";
import { killPi, launchPi, type PiLaunch } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const SHIFT_TAB = "\x1b[Z";
const CTRL_C = "\x03";

test("! runs a shell command whose output goes with the next prompt; !! keeps it out; the interrupt stops one; a lost Pi cancels one", async () => {
  const app = await launchPi();
  let again: PiLaunch | undefined;
  try {
    // A bare mark runs nothing and sends nothing, and the draft keeps it.
    await app.terminal.type("!");
    await app.terminal.waitText("» !");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("type a command after !");
    const bare = await app.terminal.text();
    assert.match(bare, /» !$/m);
    assert.doesNotMatch(bare, /▌ \$/);
    assert.equal(app.provider.requests.length, 0);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");
    // A command's words go to the shell, so the editor's rule says nothing of a skill command in them.
    await app.terminal.type("!grep -rn /skill:notes .");
    await app.terminal.waitText("» !grep -rn /skill:notes .");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.terminal.text(), /a skill loads only/);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

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
    // Read back from the session once Pi records it, the command shows once, and as ended.
    assert.equal(ran.match(/▌ \$ echo hello from the shell/g)?.length, 1);
    assert.equal(ran.match(/^ +hello from the shell\s*$/gm)?.length, 1);
    assert.doesNotMatch(ran, /◌ running|no output/);

    await app.terminal.submit("!!echo kept from the model");
    await app.terminal.waitText("not in pi's context");
    // The marks may stand apart from the command, and still keep its output from the model.
    await app.terminal.submit("!! echo also kept");
    await waitMatch(app.terminal, /^ +also kept\s*$/m);
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
    assert.doesNotMatch(body, /kept from the model|also kept/);

    // Opened again, the session draws each command as Pi recorded it ending.
    const [file] = app.sessions();
    await app.terminal.write("\x04");
    await app.terminal.waitText("Resume: pituitary --session");
    again = await launchPi({ from: app, argv: ["--session", file as string] });
    await again.terminal.waitText("Reply to: what did it say");
    await again.terminal.waitIdle();
    const reopened = await again.capture("shell-reopened");
    assert.match(reopened, /▌ \$ echo hello from the shell\n {3}hello from the shell\n/);
    assert.match(
      reopened,
      /▌ \$ echo kept from the model\n {3}kept from the model\n {3}not in pi's context\n/,
    );
    assert.match(reopened, /▌ \$ exit 3\n {3}✗ exit 3\n/);
    assert.doesNotMatch(reopened, /◌ running/);
    const pi = again;

    // A long output keeps its latest lines, half the screen's 28 rows, until ctrl+o.
    await pi.terminal.submit("!seq 1 30");
    await pi.terminal.waitText("… 16 earlier lines · ctrl+o");
    await pi.terminal.waitIdle();
    const long = await pi.capture("shell-long");
    assert.match(long, /earlier lines · ctrl\+o\n {3}17\n {3}18\n/);
    assert.match(long, /^ {3}30\b/m);
    await pi.terminal.write("\x0f");
    await waitMatch(pi.terminal, /^(?![\s\S]*earlier lines)/);
    await pi.terminal.write("\x0f");
    await pi.terminal.waitText("… 16 earlier lines · ctrl+o");

    // One line longer than the screen is wide takes the rows it wraps to out of the same half.
    await pi.terminal.submit("!printf 'y%.0s' $(seq 1 3000); echo; echo LASTLINE");
    await waitMatch(pi.terminal, /^ +LASTLINE\b/m);
    await pi.terminal.waitIdle();
    const wide = await pi.capture("shell-long-line");
    const rows = wide.split("\n").filter((line) => /^ +y{20,}/.test(line)).length;
    assert.ok(rows > 0 && rows < 14, `${rows} rows of the long line:\n${wide}`);
    assert.match(wide, /earlier lines · ctrl\+o\n( +y+.*\n)+ +LASTLINE/);

    // Pi keeps only the end of a longer output, and says where the whole of it is.
    await pi.terminal.submit("!seq 1 5000");
    await waitMatch(pi.terminal, /^ +5000\b/m);
    await pi.terminal.waitIdle();
    const truncated = await pi.capture("shell-truncated");
    assert.match(truncated, /Pi kept only the last 2000 lines · full output below/);
    assert.match(truncated, /full output: \S+/);

    // A command that runs on through a read of the session stays one entry, and what it writes
    // after the read lands in it.
    const waiting = "echo before-reread; while [ ! -e go ]; do sleep 0.1; done; echo after-reread; sleep 30";
    await pi.terminal.submit(`!${waiting}`);
    await pi.terminal.waitText("◌ running · esc esc stops");
    await waitMatch(pi.terminal, /^ +before-reread\s*$/m);
    // Cycling the thinking level reads the session again.
    await pi.terminal.write(SHIFT_TAB);
    await pi.terminal.waitText("thinking: ");
    writeFileSync(join(pi.cwd, "go"), "");
    await waitMatch(pi.terminal, /^ +after-reread\s*$/m);
    await pi.terminal.waitIdle();
    const running = await pi.capture("shell-running");
    assert.equal(running.split(`▌ $ ${waiting}`).length, 2);
    assert.match(running, /^ +before-reread\n +after-reread\n/m);
    assert.match(running, /◌ running · esc esc stops/);
    // As in Pi, one command runs at a time; the draft keeps the one that waits.
    await pi.terminal.submit("!echo second");
    await pi.terminal.waitText("a shell command is already running · stop it first");
    await waitMatch(pi.terminal, /» !echo second/);
    await pi.terminal.keyboard.press("Escape");
    await pi.terminal.keyboard.press("Escape");
    await pi.terminal.waitText("cancelled");
    await pi.terminal.waitIdle();
    const stopped = await pi.capture("shell-stopped");
    assert.doesNotMatch(stopped, /◌ running/);
    // Once the command has stopped, nothing says it still runs.
    assert.doesNotMatch(stopped, /already running/);

    // A command Pi is lost under ends cancelled, with no key offered to stop it, and the status
    // says how to come back to the session.
    await pi.terminal.write("i");
    await pi.terminal.write(CTRL_C);
    await pi.terminal.waitText("» ask pi");
    await pi.terminal.submit("!echo doomed; sleep 30");
    await pi.terminal.waitText("◌ running · esc esc stops");
    await waitMatch(pi.terminal, /^ +doomed\s*$/m);
    const asked = app.provider.requests.length;
    killPi(pi);
    await pi.terminal.waitText("Conversation disconnected: Pi exited");
    await pi.terminal.waitIdle();
    const lost = await pi.capture("shell-lost");
    assert.match(lost, /▌ \$ echo doomed; sleep 30.*\n {3}doomed.*\n {3}cancelled/);
    assert.doesNotMatch(lost, /◌ running|esc esc stops/);
    await pi.terminal.submit("still there?");
    const id = JSON.parse(readFileSync(file as string, "utf8").split("\n")[0] as string).id as string;
    await pi.terminal.waitText(`Disconnected · run pituitary --session ${id}`);
    await waitMatch(pi.terminal, /» still there\?/);
    assert.equal(app.provider.requests.length, asked);
  } finally {
    await again?.close();
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
    await app.terminal.waitIdle();
    // Pi has recorded the command run during the run by now, and it shows once.
    assert.equal((await app.terminal.text()).match(/^ +midrun-output-marker\s*$/gm)?.length, 1);

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
