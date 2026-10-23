import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { type Launched, launch, normalMode, RUNNING, waitMatch } from "./helpers/harness.ts";

const CTRL_J = "\n";
const ALT_ENTER = "\x1b\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_G = "\x07";
const ASK_HISTORY = "↑ again for the previous prompt";
const ASK_QUEUE = "↑ again to edit queued messages";
const USER = "#83a598";
const BORDER = "#504945";

/** The colour of the first cell of the lowest row that matches `rule`. */
async function ruleColour(app: Launched, rule: RegExp): Promise<unknown> {
  const row = (await app.terminal.text()).split("\n").findLastIndex((line) => rule.test(line));
  const [cell] = await app.terminal.cells(0, row, 1, 1);
  return cell?.fg;
}

after(async () => {
  await closeAll();
});

test("the first prompt sends while the initial snapshot is still arriving", async () => {
  const app = await launch({ env: { PITUITARY_FIXTURE_PENDING_SNAPSHOT: "1" } });
  try {
    assert.equal(app.profile()["session-loaded"], undefined);
    await app.terminal.submit("first prompt");
    await app.terminal.waitText("You said: first prompt", { timeout: 3000 });
  } finally {
    await app.close();
  }
});

test("ctrl+j breaks the line and enter sends both lines as one prompt", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("first line");
  await app.terminal.write(CTRL_J);
  await app.terminal.type("second line");
  await app.terminal.waitText("second line");
  const drafting = await app.capture("editor-multiline");
  assert.match(drafting, /» first line\n\s+second line/, drafting);
  await app.terminal.submit();
  await app.terminal.waitText("You said: first line");
  const sent = await app.terminal.text();
  assert.match(sent, /▌ first line\n\s*second line/, sent);
  await app.close();
});

test("up asks once before leaving the draft, then steps back through earlier prompts and down returns", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("alpha");
  await app.terminal.waitText("You said: alpha");
  await app.terminal.submit("beta");
  await app.terminal.waitText("You said: beta");
  await app.terminal.type("draft");
  await app.terminal.waitText("» draft");
  assert.equal(await ruleColour(app, /^━+$/), BORDER);
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_HISTORY);
  const asking = await app.capture("editor-recall-asks");
  assert.match(asking, /^━━ ↑ again for the previous prompt ━+\n » draft$/m, asking);
  assert.equal(await ruleColour(app, /↑ again/), USER);
  await app.terminal.write(UP);
  await app.terminal.waitText("» beta");
  const recalled = await app.terminal.text();
  assert.doesNotMatch(recalled, /↑ again/, recalled);
  // Once stepping back, each up goes one further at once.
  await app.terminal.write(UP);
  await app.terminal.waitText("» alpha");
  await app.terminal.write(DOWN);
  await app.terminal.write(DOWN);
  await app.terminal.waitText("» draft");
  // Back on the draft, leaving it asks again.
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_HISTORY);
  await app.close();
});

test("any other key between the two ups keeps the draft and takes the question back", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("alpha");
  await app.terminal.waitText("You said: alpha");
  await app.terminal.type("draft");
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_HISTORY);
  await app.terminal.type("s");
  await app.terminal.waitText("» drafts");
  await app.terminal.waitText(ASK_HISTORY, { not: true });
  assert.equal(await ruleColour(app, /^━+$/), BORDER);
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_HISTORY);
  const screen = await app.terminal.text();
  assert.match(screen, /» drafts/, screen);
  await app.close();
});

test("alt+enter queues a follow-up while the agent runs", async () => {
  const app = await launch({ scenario: "long", delayMs: 40 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.type("then summarize");
  await app.terminal.write(ALT_ENTER);
  await app.terminal.waitText("follow-up then summarize");
  await app.close();
});

test("escape during a run sends queued messages as the next prompt and keeps the draft", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("focus on errors");
  await app.terminal.waitText("steering focus on errors");
  await app.terminal.type("keep this");
  await normalMode(app.terminal);
  await app.terminal.keyboard.press("Escape");
  await app.terminal.waitText("▌ focus on errors");
  await waitMatch(app.terminal, RUNNING);
  const screen = await app.capture("queue-delivered");
  assert.match(
    screen,
    /aborted[\s\S]*▌ focus on errors/,
    `queued message not sent after the abort:\n${screen}`,
  );
  assert.doesNotMatch(screen, /steering focus on errors/, `still queued:\n${screen}`);
  assert.match(screen, /keep this/, `draft lost:\n${screen}`);
  await app.close();
});

test("up takes queued messages back without stopping the run", async () => {
  const app = await launch({ scenario: "long", delayMs: 60 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("focus on errors");
  await app.terminal.waitText("steering focus on errors");
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_QUEUE);
  await app.capture("queue-asks");
  await app.terminal.write(UP);
  await app.terminal.waitText(`${glyphs.steering} focus on errors`, { timeout: 5000 });
  const screen = await app.capture("queue-restored");
  assert.doesNotMatch(screen, /steering focus on errors/, `still queued:\n${screen}`);
  assert.match(screen, RUNNING, screen);
  await app.close();
});

test("up with nothing queued recalls an earlier prompt during a run", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_HISTORY);
  await app.terminal.write(UP);
  await app.terminal.waitText(`${glyphs.steering} write a lot`, { timeout: 5000 });
  await app.close();
});

test("up below the first line of the draft moves the cursor and leaves the queue", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("focus on errors");
  await app.terminal.waitText("steering focus on errors");
  await app.terminal.type("one");
  await app.terminal.write(CTRL_J);
  await app.terminal.type("two");
  await app.terminal.write(UP);
  await app.terminal.type("X");
  await app.terminal.waitText("oneX");
  const moved = await app.capture("queue-up-multiline");
  assert.match(moved, /steering focus on errors/, `queue taken:\n${moved}`);
  assert.match(moved, /oneX\n\s+two/, moved);
  // On the top row, a second up takes the queue back above the draft.
  await app.terminal.write(UP);
  await app.terminal.waitText(ASK_QUEUE);
  await app.terminal.write(UP);
  await app.terminal.waitText("steering focus on errors", { not: true, timeout: 5000 });
  const taken = await app.terminal.text();
  assert.match(taken, /focus on errors\n[\s\S]*oneX\n\s+two/, taken);
  await app.close();
});

test("ctrl+c clears the draft, and twice on an empty editor quits", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("scratch");
  await app.terminal.write(CTRL_C);
  await app.terminal.waitText("ask pi");
  // Clearing the draft starts the quit window too, so the next press waits it out.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await app.terminal.write(CTRL_C);
  await app.terminal.waitText("ctrl+c again to quit");
  await app.terminal.write(CTRL_C);
  await app.terminal.waitExit({ timeout: 5000 });
  await app.close();
});

test("ctrl+d on an empty editor quits", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.write(CTRL_D);
  await app.terminal.waitExit({ timeout: 5000 });
  await app.close();
});

test("ctrl+g edits the draft in the external editor", async () => {
  const app = await launch({ scenario: "hello", env: { VISUAL: "sed -i s/draft/edited/", EDITOR: "false" } });
  await app.terminal.type("a draft");
  await app.terminal.write(CTRL_G);
  await app.terminal.waitText("» a edited");
  await app.close();
});

test("a failing external editor explains the failure and preserves the draft", async () => {
  const app = await launch({ scenario: "hello", env: { PITUITARY_EDITOR: "false" } });
  await app.terminal.type("keep this draft");
  await app.terminal.write(CTRL_G);
  await app.terminal.waitText("external editor failed; your draft is unchanged");
  const screen = await app.capture("editor-external-failed");
  assert.match(screen, /» keep this draft/, screen);
  await app.terminal.type(" safely");
  await app.terminal.waitText("» keep this draft safely");
  await app.close();
});
