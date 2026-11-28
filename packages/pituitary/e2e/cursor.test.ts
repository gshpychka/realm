import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { theme } from "../packages/tui/src/theme.ts";
import { cellsOf, copied, pastGrace, press, waitGone, waitMatch } from "./helpers/harness.ts";
import { launchPi, type PiLaunch } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const CTRL_F = "\x06";
const UP = "\x1b[A";
/** Deletes what the draft's line holds before the cursor, in insert mode. */
const CTRL_U = "\x15";

const SKILL = `---
name: release-notes
description: Draft release notes from the merged pull requests
---

Gather the merged pull requests since the last tag.
`;

/** Sends `text` and waits for the provider's reply to it. */
async function ask(app: PiLaunch, text: string) {
  await app.terminal.submit(text);
  await app.terminal.waitText(`Reply to: ${text}`);
  await app.terminal.waitIdle();
}

test("a box says what its run read, edited, wrote and ran, and the call that failed last shows once it folds", async () => {
  const app = await launchPi();
  try {
    writeFileSync(join(app.cwd, "notes.ts"), "const draft = 1;\n");
    app.provider.reply(
      { tool: "read", arguments: { path: "notes.ts" } },
      {
        tool: "edit",
        arguments: {
          path: "notes.ts",
          edits: [{ oldText: "const draft = 1;", newText: "const draft = 2;\nconst kept = 3;" }],
        },
      },
      { tool: "write", arguments: { path: "summary.md", content: "# Summary\n" } },
      { tool: "bash", arguments: { command: "printf 'one\\n'\nprintf 'two\\n'\nprintf 'three\\n'" } },
      { tool: "bash", arguments: { command: "exit 4" } },
      "Tidied the notes; the check failed.",
    );
    await app.terminal.submit("tidy the notes");
    await app.terminal.waitText("Tidied the notes; the check failed.");
    await app.terminal.waitIdle();
    const done = await app.capture("cursor-pi-summary");
    assert.match(
      done,
      /^ ▸ \S+ read notes\.ts · edited notes\.ts \+2 −1 · wrote summary\.md · ran 2 commands · 1 failed$/m,
    );
    // A command of several lines heads its row with its first, and says how many follow.
    assert.match(done, /^ {3}✓ \$ printf 'one\\n' … \+2 lines$/m);
    assert.doesNotMatch(done, /printf 'two/);

    // Open, it says how many lines it leaves out; at full length, it shows them all.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "enter open · o full length");
    await app.terminal.write("\r");
    await app.terminal.waitText("✓ $ printf 'one\\n' … +2 lines");
    await app.terminal.write("o");
    await app.terminal.waitText("printf 'three\\n'");
    await app.capture("cursor-pi-command-whole");
    await app.terminal.write("\r");
    await app.terminal.waitText("enter open");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /esc back/);

    await ask(app, "thanks");
    const folded = await app.capture("cursor-pi-folded");
    assert.match(folded, /1 failed\n {3}✗ \$ exit 4\n\n ● Tidied the notes/);
    const [cross] = await cellsOf(app.terminal, "✗ $ exit 4");
    assert.equal(cross?.fg, theme.error);
  } finally {
    await app.close();
  }
});

test("a box stays at work while the reply after it is still being written, which may yet call a tool", async () => {
  const app = await launchPi({ apiModels: [{ id: "held-replies" }] });
  try {
    writeFileSync(join(app.cwd, "notes.ts"), "const draft = 1;\n");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.provider.reply(
      { tool: "read", arguments: { path: "notes.ts" } },
      { text: "Read the notes.", until: held },
    );
    await app.terminal.submit("read the notes");
    const writing = await waitMatch(app.terminal, /● Read the notes\./);
    assert.match(writing, /^ ◌ \S+ read notes\.ts$/m);
    release();
    await waitMatch(app.terminal, /^ ▸ \S+ read notes\.ts$/m);
  } finally {
    await app.close();
  }
});

test("the cursor copies a skill prompt as typed and a shell command with its output, and opens a compaction's summary", async () => {
  const app = await launchPi({
    skills: { "release-notes": SKILL },
    // Every message is old enough to fold into the summary.
    settings: { compaction: { keepRecentTokens: 0 } },
    record: true,
  });
  try {
    await app.terminal.submit("!echo from the shell");
    await waitMatch(app.terminal, /^ +from the shell\s*$/m);
    app.provider.reply("Drafted the notes.");
    await app.terminal.submit("/skill:release-notes focus on the footer");
    await app.terminal.waitText("Drafted the notes.");
    await app.terminal.waitIdle();

    await app.terminal.write(CTRL_F);
    // A reply asks other models to weigh in, or copies.
    await app.terminal.waitText("━━ ↑↓ move · w weigh in · c copy · esc back ━");
    await app.terminal.write(UP);
    // The skill's chip opens to its instructions; the prompt forks, edits and copies as it was typed.
    await app.terminal.waitText("↑↓ move · enter show skill · f fork · e edit · c copy · esc back");
    await app.capture("cursor-pi-skill-prompt");
    await app.terminal.write("c");
    await app.terminal.waitText("━━ copied the prompt ━");
    await app.terminal.waitIdle();
    assert.equal(copied(app.raw()), "/skill:release-notes focus on the footer");
    await app.terminal.write("\r");
    await app.terminal.waitText("Gather the merged pull requests since the last tag.");
    await app.terminal.waitText("enter hide skill");

    await app.terminal.write(UP);
    await waitMatch(app.terminal, /^┃▌ \$ echo from the shell/m);
    await app.terminal.waitText("━━ ↑↓ move · c copy · esc back ━");
    await app.capture("cursor-pi-shell");
    await app.terminal.write("c");
    await app.terminal.waitText("copied the command and its output");
    await app.terminal.waitIdle();
    assert.equal(copied(app.raw()), "$ echo from the shell\nfrom the shell");
    await app.terminal.keyboard.press("Escape");
    // The bar leaves with the cursor, which then takes no more keys.
    await waitGone(app.terminal, /^┃/m);

    // Pi summarizes a turn the cut splits apart with a request of its own.
    const SUMMARY = "The operator ran a command and asked for release notes.";
    app.provider.reply(SUMMARY, SUMMARY);
    await app.terminal.type("/compact");
    await app.terminal.waitText("» /compact");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("[compaction]", { timeout: 15_000 });
    await app.terminal.waitIdle();
    // Up from the latest item to the summary that now leads the conversation.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "enter expand");
    await app.terminal.waitText("━━ ↑↓ move · enter expand · c copy · esc back ━");
    await app.terminal.write("\r");
    await app.terminal.waitText(SUMMARY);
    await app.terminal.waitText("enter fold");
    await app.capture("cursor-pi-summary-open");
  } finally {
    await app.close();
  }
});

test("a skill's instructions the cursor showed stay with that prompt, not one that takes its place", async () => {
  const app = await launchPi({ skills: { "release-notes": SKILL } });
  try {
    app.provider.reply("Drafted the notes.");
    await app.terminal.submit("/skill:release-notes focus on the footer");
    await app.terminal.waitText("Drafted the notes.");
    await app.terminal.waitIdle();
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "enter show skill");
    await app.terminal.write("\r");
    await app.terminal.waitText("Gather the merged pull requests since the last tag.");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /esc back/);
    // A new session's first prompt stands where the last one's did.
    await app.terminal.submit("/new");
    await waitGone(app.terminal, /Drafted the notes/);
    app.provider.reply("Drafted them again.");
    await app.terminal.submit("/skill:release-notes focus on the header");
    await app.terminal.waitText("Drafted them again.");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.capture("cursor-pi-skill-new"), /Gather the merged/);
  } finally {
    await app.close();
  }
});

test("f forks a new session from before a prompt and e moves this one back to it, each prompt into the draft", async () => {
  const app = await launchPi();
  try {
    await ask(app, "alpha");
    await ask(app, "beta");

    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("━━ ↑↓ move · w weigh in · c copy · esc back ━");
    await app.terminal.write(UP);
    await app.terminal.waitText("━━ ↑↓ move · f fork · e edit · c copy · esc back ━");
    await app.capture("cursor-pi-prompt");
    await app.terminal.write("f");
    await app.terminal.waitText("Forked into a new session · editing your earlier prompt");
    await waitMatch(app.terminal, /» beta/);
    await app.terminal.waitIdle();
    const forked = await app.capture("cursor-pi-forked");
    assert.doesNotMatch(forked, /Reply to: beta/);
    assert.match(forked, /Reply to: alpha/);
    assert.equal(app.sessions().length, 2);

    await app.terminal.write(CTRL_U);
    await app.terminal.waitText("» ask pi");
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("━━ ↑↓ move · c copy · esc back ━");
    // Up past the fork's notice and the reply, to the prompt.
    await press(app.terminal, UP, "f fork · e edit");
    await app.terminal.write("e");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» alpha/);
    await app.terminal.waitIdle();
    const edited = await app.capture("cursor-pi-edited");
    assert.doesNotMatch(edited, /Reply to: alpha/);
    // Nothing was asked for the move: the provider heard only the two prompts.
    assert.equal(app.provider.requests.length, 2);
  } finally {
    await app.close();
  }
});

test("a prompt's bar runs down every row it wraps to, and a template's last newline adds no row", async () => {
  const app = await launchPi({ prompts: { review: "Review the error handling.\n" }, cols: 60 });
  try {
    await app.terminal.submit(
      "a prompt long enough to wrap onto a second row and then onto a third one at sixty columns",
    );
    await waitMatch(app.terminal, /at \d\d:\d\d/);
    await app.terminal.waitIdle();
    const wrapped = (await app.capture("cursor-pi-wrapped")).split("\n");
    const first = wrapped.findIndex((row) => row.includes("a prompt long enough"));
    const rows = wrapped.slice(first, wrapped.indexOf("", first));
    assert.ok(rows.length >= 2, wrapped.join("\n"));
    for (const row of rows) assert.match(row, /^ ▌ /);
    await app.terminal.submit("/review");
    await app.terminal.waitText("Reply to: Review the error handling.");
    await app.terminal.waitIdle();
    assert.match(await app.capture("cursor-pi-template"), /▌ Review the error handling\.\n\n ● Reply to/);
  } finally {
    await app.close();
  }
});
