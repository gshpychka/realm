import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { pastGrace, press, waitMatch } from "./helpers/harness.ts";
import { launchPi, type PiLaunch } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
/** Deletes what the draft's line holds before the cursor, in insert mode. */
const CTRL_U = "\x15";

/** Sends `text` and waits for the provider's reply to it. */
async function ask(app: PiLaunch, text: string) {
  await app.terminal.submit(text);
  await app.terminal.waitText(`Reply to: ${text}`);
  await app.terminal.waitIdle();
}

/** Opens the tree list and waits for it to settle. */
async function tree(app: PiLaunch) {
  await app.terminal.submit("/tree");
  await app.terminal.waitText("tree · move to another point of this session");
  await app.terminal.waitIdle();
}

test("/tree moves back before an earlier prompt, which comes back to the draft, then summarizes a branch it leaves", async () => {
  const app = await launchPi();
  try {
    await ask(app, "alpha");
    await ask(app, "beta");
    await tree(app);
    const listed = await app.capture("tree-list");
    // The session stands on its latest reply; every entry of the one branch stays in one column.
    assert.match(listed, /▶ ● Reply to: beta · current +\d\d:\d\d +│/);
    assert.match(listed, /^│ {3}▌ alpha +\d\d:\d\d +│$/m);
    await press(app.terminal, UP, "▶ ▌ beta");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await app.terminal.waitIdle();
    await app.capture("tree-summary-question");
    await pastGrace();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» beta/);
    await app.terminal.waitIdle();
    const moved = await app.capture("tree-moved");
    assert.match(moved, /Reply to: alpha/);
    assert.doesNotMatch(moved, /Reply to: beta/);
    // No summary was asked for, so the provider heard only the two prompts.
    assert.equal(app.provider.requests.length, 2);

    // Asking something else from there leaves beta on a branch of its own.
    await app.terminal.write(CTRL_U);
    await ask(app, "gamma");
    await tree(app);
    const branched = await app.capture("tree-branches");
    assert.match(branched, /^│ {3}├─ ▌ gamma +\d\d:\d\d +│$/m);
    assert.match(branched, /▶ │ {2}● Reply to: gamma · current/);
    assert.match(branched, /^│ {3}└─ ▌ beta +\d\d:\d\d +│$/m);
    assert.match(branched, /^│ {6}● Reply to: beta +\d\d:\d\d +│$/m);

    // A capital L labels the entry under the cursor, and the list comes back on it.
    await press(app.terminal, DOWN, "▶ └─ ▌ beta");
    await app.terminal.write("L");
    await app.terminal.waitText("Label “beta” · an empty label takes it off");
    await pastGrace();
    await app.terminal.type("first try");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /▶ └─ ▌ beta +\S+ first try · \d\d:\d\d/);
    await app.terminal.waitIdle();
    await app.capture("tree-labelled");

    // A move off gamma's branch with a summary: the provider answers the summary request.
    app.provider.reply("The branch asked gamma and was answered.");
    await press(app.terminal, DOWN, "▶    ● Reply to: beta");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await press(app.terminal, DOWN, "▶ Summarize");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Moved to that point of the session");
    await app.terminal.waitText("[branch] summary of the branch you left");
    await app.terminal.waitIdle();
    const summarized = await app.capture("tree-summarized");
    assert.match(summarized, /Reply to: alpha[\s\S]*beta[\s\S]*Reply to: beta[\s\S]*\[branch\]/);
    assert.doesNotMatch(summarized, /Reply to: gamma/);
    assert.equal(app.provider.requests.length, 4);
    assert.match(JSON.stringify(app.provider.requests[3]?.body), /gamma/);
    await app.terminal.write("\x0f");
    await app.terminal.waitText("The branch asked gamma and was answered.");
    await app.capture("tree-summary-expanded");
    await app.terminal.write("\x0f");

    // The summary is in the context the next prompt goes with.
    await ask(app, "delta");
    assert.match(
      JSON.stringify(app.provider.requests.at(-1)?.body),
      /The branch asked gamma and was answered/,
    );
  } finally {
    await app.close();
  }
});

test("a move that summarizes stops on the interrupt and the list comes back where it was", async () => {
  const app = await launchPi({ cols: 80, rows: 24 });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await ask(app, "alpha");
    await ask(app, "beta");
    await tree(app);
    await app.capture("tree-list-80");
    app.provider.reply({ text: "never shown", until: held });
    await press(app.terminal, UP, "▶ ▌ beta");
    await press(app.terminal, UP, "▶ ● Reply to: alpha");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await press(app.terminal, DOWN, "▶ Summarize");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("summarizing the branch you leave · esc esc stops");
    await app.capture("tree-summarizing");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("stopped summarizing · the session stays where it was");
    await app.terminal.waitText("▶ ● Reply to: alpha");
    await app.terminal.waitIdle();
    const stopped = await app.capture("tree-summary-stopped");
    assert.doesNotMatch(stopped, /summarizing the branch/);
    await app.terminal.keyboard.press("Escape");
    // The session stayed on beta's reply.
    await app.terminal.waitText("Reply to: beta");
    assert.doesNotMatch(await app.terminal.text(), /\[branch\]/);
    // The tree list's own key is listed with the list it works in.
    await app.terminal.submit("/hotkeys");
    await waitMatch(app.terminal, /shift\+l +tree\.editLabel · in \/tree/);
  } finally {
    release();
    await app.close();
  }
});
