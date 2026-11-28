import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { cellsOf, pastGrace, press, RUNNING, waitMatch } from "./helpers/harness.ts";
import { launchPi, type PiLaunch } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
/** Deletes what the draft's line holds before the cursor, in insert mode. */
const CTRL_U = "\x15";
/** Clears the draft. */
const CTRL_C = "\x03";
const BACKSPACE = "\x7f";
/** A turn's figures row: how long it took, and more. */
const FIGURES = /\n\n \S+ \d+s · /;

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
    // The bridge answers out of band, so nothing of its reply shows.
    assert.doesNotMatch(listed, /"ok":|"id":|pituitary-\d+/);
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
    // The turn the session keeps keeps its figures.
    assert.match(moved, new RegExp(`Reply to: alpha${FIGURES.source}`));
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
    // A branch the session is not on reads dim beside the one it is on.
    const [, , , , , here] = await cellsOf(app.terminal, "├─ ▌ gamma");
    const [, , , , , aside] = await cellsOf(app.terminal, "└─ ▌ beta");
    assert.notDeepEqual(here?.fg, aside?.fg);

    // A capital L labels the entry under the cursor, and the list comes back on it.
    await press(app.terminal, DOWN, "▶ └─ ▌ beta");
    await app.terminal.write("L");
    await app.terminal.waitText("Label “beta” · an empty label takes it off");
    await pastGrace();
    await app.terminal.type("first try");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /▶ └─ ▌ beta +\S+ first try · \d\d:\d\d/);
    await app.terminal.waitIdle();
    const labelled = await app.capture("tree-labelled");
    // A label is bookkeeping Pi's session now stands on, which has no row, so the reply before it stays current.
    assert.match(labelled, /^│ {3}│ {2}● Reply to: gamma · current +\d\d:\d\d +│$/m);
    // Labelling it again starts from its label, which enter keeps.
    await app.terminal.write("L");
    await app.terminal.waitText("enter save");
    await app.capture("tree-relabel");
    await pastGrace();
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /▶ └─ ▌ beta +\S+ first try · \d\d:\d\d/);
    // An empty label takes it off.
    await app.terminal.write("L");
    await app.terminal.waitText("enter save");
    await pastGrace();
    await app.terminal.write(BACKSPACE.repeat("first try".length));
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /▶ └─ ▌ beta +\d\d:\d\d/);
    assert.doesNotMatch(await app.terminal.text(), /first try/);

    // A move off gamma's branch with a summary the operator instructs: the provider answers the
    // summary request, which carries the instructions.
    app.provider.reply("The branch asked gamma and was answered.");
    await press(app.terminal, DOWN, "▶    ● Reply to: beta");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await press(app.terminal, DOWN, "▶ Summarize with custom prompt");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Instructions for the summary");
    await pastGrace();
    await app.terminal.type("mention only gamma");
    // The instructions are an editor of their own, which ctrl+s saves.
    await app.terminal.write("\x13");
    await app.terminal.waitText("Moved to that point of the session");
    await app.terminal.waitText("[branch] summary of the branch you left");
    await app.terminal.waitIdle();
    const summarized = await app.capture("tree-summarized");
    assert.match(summarized, /Reply to: alpha[\s\S]*beta[\s\S]*Reply to: beta[\s\S]*\[branch\]/);
    assert.doesNotMatch(summarized, /Reply to: gamma/);
    assert.equal(app.provider.requests.length, 4);
    assert.match(JSON.stringify(app.provider.requests[3]?.body), /gamma/);
    assert.match(JSON.stringify(app.provider.requests[3]?.body), /mention only gamma/);
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

    // A list of more rows than most takes up to half the screen, and a summary's row says what it holds.
    await ask(app, "epsilon");
    await ask(app, "zeta");
    await tree(app);
    const tall = await app.capture("tree-tall");
    assert.match(tall, / 13 of 13 /);
    assert.match(tall, /^│ {3}▌ alpha /m);
    assert.match(tall, /branch summary · The branch asked gamma and was answered\./);
    // A filtered list leaves out rows between its matches, so it draws no lines between branches.
    await app.terminal.type("reply");
    await app.terminal.waitText("6 of 13");
    const filtered = await app.capture("tree-filtered");
    assert.match(filtered, /^│ {3}● Reply to: gamma /m);
    assert.doesNotMatch(filtered, /^│ [▶ ] [│├└]/m);
    await app.terminal.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("with Pi set to skip the summary question a move goes straight back, and the tree steps in forks inside branches and a second root", async () => {
  const app = await launchPi({ settings: { branchSummary: { skipPrompt: true } } });
  try {
    await ask(app, "alpha");
    await ask(app, "beta");
    await ask(app, "gamma");
    // Pi's setting skips the question: the move goes straight back, and asks the provider nothing.
    await tree(app);
    await press(app.terminal, UP, "▶ ▌ gamma");
    await press(app.terminal, UP, "▶ ● Reply to: beta");
    await press(app.terminal, UP, "▶ ▌ beta");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» beta/);
    assert.doesNotMatch(await app.terminal.text(), /Summarize the branch you leave\?/);
    assert.equal(app.provider.requests.length, 3);
    await app.terminal.write(CTRL_U);
    await ask(app, "delta");

    // A fork inside a branch steps in again beside the line of the fork above it.
    await tree(app);
    await press(app.terminal, DOWN, "▶    ▌ gamma");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» gamma/);
    await app.terminal.write(CTRL_U);
    await ask(app, "epsilon");
    await tree(app);
    const nested = await app.capture("tree-nested");
    assert.match(nested, /^│ {3}├─ ▌ beta +\d\d:\d\d +│$/m);
    assert.match(nested, /^│ {3}│ {2}● Reply to: beta +\d\d:\d\d +│$/m);
    assert.match(nested, /^│ {3}│ {2}├─ ▌ epsilon +\d\d:\d\d +│$/m);
    assert.match(nested, /▶ │ {2}│ {2}● Reply to: epsilon · current/);
    assert.match(nested, /^│ {3}│ {2}└─ ▌ gamma +\d\d:\d\d +│$/m);
    assert.match(nested, /^│ {3}│ {5}● Reply to: gamma +\d\d:\d\d +│$/m);
    assert.match(nested, /^│ {3}└─ ▌ delta +\d\d:\d\d +│$/m);

    // Asked afresh from before its first prompt, the session has two roots, its own first.
    await press(app.terminal, UP, "▶ ▌ alpha", 10_000);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» alpha/);
    await app.terminal.write(CTRL_U);
    await ask(app, "omega");
    await tree(app);
    const roots = await app.capture("tree-roots");
    assert.match(roots, /^│ {3}├─ ▌ omega +\d\d:\d\d +│$/m);
    assert.match(roots, /▶ │ {2}● Reply to: omega · current/);
    assert.match(roots, /^│ {3}└─ ▌ alpha +\d\d:\d\d +│$/m);
    // The older root's entries go on in its own column.
    assert.match(roots, /^│ {6}● Reply to: alpha +\d\d:\d\d +│$/m);
    assert.match(roots, /^│ {6}├─ ▌ beta +\d\d:\d\d +│$/m);
    // No move asked for a summary.
    assert.deepEqual(
      app.provider.requests.map((request) => request.prompt),
      ["alpha", "beta", "gamma", "delta", "epsilon", "omega"],
    );
    await app.terminal.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});

test("a session as long as fifty thousand entries opens in /tree and filters", async () => {
  const app = await launchPi();
  let again: PiLaunch | undefined;
  try {
    await ask(app, "alpha");
    // A second session in the same place, written as Pi writes one: its header, settings and a
    // chain of prompts and replies, then a short branch off its first reply that the session
    // stands on, so the conversation drawn stays short while the tree is long.
    const [file] = app.sessions();
    const [header, ...entries] = readFileSync(file as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const settings = entries.filter((entry) => entry.type !== "message");
    const role = (name: string) =>
      entries.find((entry) => (entry.message as { role?: string } | undefined)?.role === name);
    const [user, reply] = [role("user"), role("assistant")];
    const said = (
      entry: Record<string, unknown> | undefined,
      id: string,
      parentId: unknown,
      text: string,
    ) => ({
      ...entry,
      id,
      parentId,
      message: { ...(entry?.message as object), content: [{ type: "text", text }] },
    });
    const CHAIN = 50_000;
    const lines: unknown[] = [{ ...header, id: randomUUID() }, ...settings];
    let parent = settings.at(-1)?.id ?? null;
    for (let step = 0; step < CHAIN; step++) {
      const id = step.toString(16).padStart(8, "0");
      lines.push(said(step % 2 ? reply : user, id, parent, `step ${step}`));
      parent = id;
    }
    lines.push(said(user, "fffffff0", (1).toString(16).padStart(8, "0"), "short"));
    lines.push(said(reply, "fffffff1", "fffffff0", "Reply to: short"));
    const long = join(dirname(file as string), `long_${randomUUID()}.jsonl`);
    writeFileSync(long, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await app.terminal.write("\x04");
    await app.terminal.waitText("Resume: pituitary --session");

    again = await launchPi({ from: app, argv: ["--session", long] });
    await again.terminal.waitText("Reply to: short");
    await again.terminal.waitIdle();
    await tree(again);
    const listed = await again.capture("tree-long");
    assert.doesNotMatch(listed, /\/tree:/);
    assert.match(listed, / 50002 of 50002 /);
    assert.match(listed, /▶ │ {2}● Reply to: short · current/);
    assert.match(listed, /^│ {3}└─ ▌ step 2 +\d\d:\d\d +│$/m);
    await again.terminal.type("step 49999");
    await again.terminal.waitText("1 of 50002");
    await waitMatch(again.terminal, /▶ ● step 49999/);
  } finally {
    await again?.close();
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
    // Pi would run a prompt on the branch the move leaves, so the draft keeps it until the summary is done.
    const asked = app.provider.requests.length;
    await app.terminal.submit("gamma");
    await app.terminal.waitText("the draft waits for the branch summary · esc esc stops it");
    await waitMatch(app.terminal, /» gamma/);
    await app.terminal.waitIdle();
    await app.capture("tree-summary-waits");
    assert.equal(app.provider.requests.length, asked);
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
    assert.equal(app.provider.requests.length, asked);
    await app.terminal.write(CTRL_C);
    await waitMatch(app.terminal, /» ask pi/);
    // The tree list's own key is listed with the list it works in.
    await app.terminal.submit("/hotkeys");
    await waitMatch(app.terminal, /shift\+l +tree\.editLabel · in \/tree/);
  } finally {
    release();
    await app.close();
  }
});

test("a move while Pi works takes the queue back and keeps the branch it moves to; a summary that fails gives the queue back", async () => {
  const app = await launchPi();
  const releases: (() => void)[] = [];
  const held = () => new Promise<void>((resolve) => releases.push(resolve));
  try {
    await ask(app, "alpha");
    await ask(app, "beta");
    app.provider.reply({ text: "never shown", until: held() });
    await app.terminal.submit("gamma");
    await waitMatch(app.terminal, RUNNING);
    await app.terminal.submit("queued one");
    await waitMatch(app.terminal, /^ +.*queued one/m);
    await app.terminal.submit("/tree");
    await app.terminal.waitText("tree · move to another point of this session");
    await press(app.terminal, UP, "▶ ● Reply to: beta");
    await press(app.terminal, UP, "▶ ▌ beta");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» beta/);
    await app.terminal.waitIdle();
    const moved = await app.capture("tree-moved-while-working");
    // The run stopped, the session stands before beta with its first turn drawn, and the queue is in the draft.
    assert.match(moved, new RegExp(`▌ alpha\n\n ● Reply to: alpha${FIGURES.source}`));
    assert.doesNotMatch(moved, /▌ (beta|gamma)|never shown/);
    assert.doesNotMatch(moved, RUNNING);
    assert.match(moved, /^ +queued one/m);
    assert.deepEqual(
      app.provider.requests.map((request) => request.prompt),
      ["alpha", "beta", "gamma"],
    );

    // A summary the provider refuses leaves the session where it was and the queue in the draft.
    await app.terminal.write(CTRL_C);
    await waitMatch(app.terminal, /» ask pi/);
    app.provider.reply(
      { text: "never shown", until: held() },
      { status: 500, body: { error: { message: "no summaries today" } } },
    );
    await app.terminal.submit("delta");
    await waitMatch(app.terminal, RUNNING);
    await app.terminal.submit("queued two");
    await waitMatch(app.terminal, /^ +.*queued two/m);
    await app.terminal.submit("/tree");
    await app.terminal.waitText("tree · move to another point of this session");
    await press(app.terminal, UP, "▶ ● Reply to: alpha");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await press(app.terminal, DOWN, "▶ Summarize");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /\/tree: \S/);
    await app.terminal.waitText("tree · move to another point of this session");
    await waitMatch(app.terminal, /» queued two/);
    await app.terminal.waitIdle();
    const failed = await app.capture("tree-summary-failed");
    // The reply the move stopped reads in the list as the conversation says it.
    assert.match(failed, /^ ▌ delta\n\n {3}interrupted$/m);
    assert.match(failed, /● interrupted · current/);
    assert.equal(app.provider.requests.length, 5);
    await app.terminal.keyboard.press("Escape");
    await waitMatch(app.terminal, /▌ delta/);
  } finally {
    for (const release of releases) release();
    await app.close();
  }
});
