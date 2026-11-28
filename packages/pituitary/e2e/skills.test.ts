import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { cellsOf, normalMode, pastGrace, RUNNING, waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const UP = "\x1b[A";
const CTRL_C = "\x03";
const CTRL_J = "\n";
const CTRL_O = "\x0f";
const ALT_S = "\x1bs";
const ALT_F = "\x1bf";
const BACKSPACE = "\x7f";

const SKILL = `---
name: release-notes
description: Draft release notes from the merged pull requests
---

# Release notes

1. Gather the merged pull requests since the last tag.
2. Group them by area and write one line per change.
`;

/** A skill whose name is longer than a list's label column. */
const LONG_NAME = "a-very-long-skill-name-for-layout-checks";
const LONG_SKILL = `---
name: ${LONG_NAME}
description: Checks layout
---

Check the layout.
`;

/** A prompt template that declares the argument it needs. */
const REVIEW = `---
description: Review the change
argument-hint: <focus>
---
Review this, focusing on $@
`;

/** A skill's chip as a capture's text reads it: its label between the chip's rounded ends. */
const CHIP = `${glyphs.chipStart}${glyphs.skill} skill release-notes${glyphs.chipEnd}`;

test("a chosen skill leads the draft, shows as a chip once sent, loads in the work, and comes back as typed, from the tree too", async () => {
  const app = await launchPi({
    skills: { "release-notes": SKILL, [LONG_NAME]: LONG_SKILL },
    prompts: { review: REVIEW },
  });
  try {
    const file = join(app.agent, "skills", "release-notes", "SKILL.md");
    // The skill completes by its own name, marked as a skill and asking for a request.
    await app.terminal.type("/notes");
    await app.terminal.waitText("/skill:release-notes [request]");
    const completing = await app.capture("skills-completion");
    assert.match(
      completing,
      new RegExp(`▶ ${glyphs.skill} /skill:release-notes \\[request\\] +Draft release notes`),
    );
    assert.match(completing, /tab enter complete/);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A name too long for the list gives way to the request it asks for, which stays whole.
    await app.terminal.type("/skill:");
    await app.terminal.waitText("Checks layout");
    await app.terminal.waitIdle();
    assert.match(
      await app.capture("skills-completion-long"),
      /\/skill:a-very-long\S*… \[request\] +Checks layout/,
    );
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A prompt template that declares an argument shows it, and enter waits for it.
    await app.terminal.type("/review");
    await app.terminal.waitText("/review <focus>");
    await app.terminal.waitIdle();
    assert.match(await app.capture("skills-template-completion"), /tab enter complete/);
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /» \/review *$/m);
    assert.equal(app.provider.requests.length, 0);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // `/skills` opens the list filtered by what follows it.
    await app.terminal.submit("/skills rel");
    await app.terminal.waitText("1 of 2");
    await app.terminal.waitIdle();
    assert.match(await app.capture("skills-command"), /filter rel/);
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /» \/skill:release-notes *$/m);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // The list of skills puts the chosen one before what the draft holds, which becomes its
    // request. Whose each skill is follows its name.
    await app.terminal.type("focus on the footer");
    await app.terminal.waitText("» focus on the footer");
    await app.terminal.write(ALT_S);
    await app.terminal.waitText("skills · the draft becomes the request");
    await app.terminal.waitIdle();
    const picker = await app.capture("skills-picker");
    assert.match(picker, / release-notes · user +Draft release notes from the merged pull requests/);
    assert.match(picker, / a-very-long\S* · user +Checks layout/);
    await app.terminal.type("release");
    await app.terminal.waitText("1 of 2");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
    await app.terminal.waitIdle();
    await app.capture("skills-draft");

    // The model reads the skill's file, then answers.
    app.provider.reply({ tool: "read", arguments: { path: file } }, "Drafted the notes.");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Drafted the notes.");
    await app.terminal.waitIdle();
    const sent = await app.capture("skills-sent");
    assert.match(
      app.provider.requests[0]?.prompt ?? "",
      /^<skill name="release-notes" location="[^"]+SKILL\.md">/,
    );
    assert.match(app.provider.requests[0]?.prompt ?? "", /focus on the footer$/);
    // The message shows the chip and the request; the instructions stay folded.
    assert.ok(sent.includes(`▌ ${CHIP} focus on the footer · ctrl+o`), sent);
    assert.doesNotMatch(sent, /<skill|Gather the merged|References are relative/);
    assert.match(sent, /▸ \S+ used skill release-notes$/m);

    // Expanded, the skill's file and instructions follow the message, and the read names the skill.
    await app.terminal.write(CTRL_O);
    await app.terminal.waitText("Gather the merged pull requests since the last tag.");
    await app.terminal.waitIdle();
    const expanded = await app.capture("skills-expanded");
    assert.match(expanded, /~\/\.pi\/agent\/skills\/release-notes\/SKILL\.md/);
    assert.match(expanded, new RegExp(`✓ ${glyphs.skill} skill release-notes`));
    await app.terminal.write(CTRL_O);
    await waitMatch(app.terminal, /^(?![\s\S]*Gather the merged)/);

    // Up brings the prompt back as typed, never the expanded skill.
    await app.terminal.write(UP);
    await app.terminal.waitText("↑ again for the previous prompt");
    await app.terminal.write(UP);
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
    await app.terminal.waitIdle();
    await app.capture("skills-recalled");
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // The tree lists the prompt as typed, tagged as a skill's, and its filter reads the command
    // and the request, never the instructions Pi expanded it into.
    await app.terminal.submit("/tree");
    await app.terminal.waitText("tree · move to another point of this session");
    await app.terminal.waitIdle();
    const listed = await app.capture("skills-tree");
    assert.match(listed, /^│ {3}▌ \/skill:release-notes focus on the footer · skill +\d\d:\d\d +│$/m);
    assert.doesNotMatch(listed, /<skill|Gather the merged|References are relative/);
    await app.terminal.type("gather");
    await app.terminal.waitText("nothing matches");
    await app.terminal.write(BACKSPACE.repeat("gather".length));
    await app.terminal.waitText("2 of 2");
    await app.terminal.type("footer");
    await app.terminal.waitText("1 of 2");
    // Moving there puts the prompt back in the draft as typed, where it shows as a chip again.
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Back before that prompt · editing it in the draft");
    await waitMatch(app.terminal, /» \/skill:release-notes focus on the footer *$/m);
    await app.terminal.waitIdle();
    const moved = await app.capture("skills-tree-draft");
    assert.doesNotMatch(moved, /<skill|Gather the merged/);
    const [named, , request] = await cellsOf(app.terminal, "s focus");
    assert.notDeepEqual(named?.bg, request?.bg);
    // Sent again from there, the skill loads as it did the first time.
    app.provider.reply("Drafted them again.");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Drafted them again.");
    await app.terminal.waitIdle();
    const again = app.provider.requests.at(-1)?.prompt ?? "";
    assert.match(again, /^<skill name="release-notes" location="[^"]+SKILL\.md">/);
    assert.match(again, /focus on the footer$/);

    // A narrow screen reads the same. The editor's rule spans the new width once the screen
    // has drawn at it.
    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /^━{80}\n » ask pi/m);
    await app.terminal.waitIdle();
    await app.capture("skills-sent-80");

    // A fork lists the prompt as typed and puts it back in the draft so.
    await app.terminal.write(ALT_F);
    await app.terminal.waitText("fork · a new session from before an earlier prompt");
    await app.terminal.waitIdle();
    assert.match(
      await app.capture("skills-fork-picker"),
      /▶ \/skill:release-notes focus on the footer · skill +latest prompt/,
    );
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Forked into a new session");
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
  } finally {
    await app.close();
  }
});

test("a queued skill shows as a chip, comes back as typed, and still loads when the run is interrupted; the editor flags what Pi would not expand", async () => {
  const app = await launchPi({ skills: { "release-notes": SKILL } });
  let release = () => {};
  try {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.provider.reply({ text: "Working on it.", until: held });
    await app.terminal.submit("start the long job");
    await waitMatch(app.terminal, RUNNING);
    await app.terminal.submit("/skill:release-notes later please");
    const queued = `${glyphs.steering} steering ${CHIP} later please`;
    await app.terminal.waitText(queued);
    await app.terminal.waitIdle();
    const panel = await app.capture("skills-queued");
    assert.doesNotMatch(panel, /<skill|Gather the merged/);

    // Taken back, the queued message is the command that loaded the skill.
    await app.terminal.write(UP);
    await app.terminal.waitText("↑ again to edit queued messages");
    await app.terminal.write(UP);
    // The run goes on, so the draft carries the steering mark.
    await app.terminal.waitText(`${glyphs.steering} /skill:release-notes later please`);
    await waitMatch(app.terminal, new RegExp(`^(?![\\s\\S]*${glyphs.steering} steering)`));

    // Queued again and the run interrupted, the message goes to Pi as Pi expanded it, so the
    // skill loads in the prompt that follows.
    await app.terminal.type(" and group them by area so that each team finds its own changes quickly");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText(queued);
    app.provider.reply("Picked up the notes.");
    await normalMode(app.terminal);
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("Picked up the notes.");
    await app.terminal.waitIdle();
    const interrupted = await app.capture("skills-interrupted");
    const resent = app.provider.requests[1]?.prompt ?? "";
    assert.match(resent, /^<skill name="release-notes" /);
    assert.match(resent, /its own changes quickly$/);
    assert.ok(interrupted.includes(`▌ ${CHIP} later please and group`), interrupted);
    // The key that shows the skill follows the request's last words, never alone on a row.
    assert.match(interrupted, /quickly +· ctrl\+o/);
    assert.doesNotMatch(interrupted, /^\W*· ctrl\+o/m);
    // The conversation wraps again at a narrower width once it has drawn there.
    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /^━{80}\n/m);
    // The prompt's bar runs down the row it wraps to.
    await waitMatch(app.terminal, /^ ▌ that each team finds its own changes quickly +· ctrl\+o/m);
    await app.terminal.waitIdle();
    const narrow = await app.capture("skills-interrupted-80");
    assert.doesNotMatch(narrow, /^\W*· ctrl\+o/m);
    await app.terminal.resize(100, 28);
    await waitMatch(app.terminal, /^━{100}\n/m);

    // Pi expands only a leading skill command, and the editor's rule says so.
    await app.terminal.write("i");
    await app.terminal.waitText("» ask pi");
    await app.terminal.type("please use /skill:release-notes");
    await app.terminal.waitText("a skill loads only from /skill: at the start of the draft");
    await app.terminal.waitIdle();
    await app.capture("skills-flag");
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");
    // Pi reads the name up to the first space, so the request starts on the command's line.
    await app.terminal.type("/skill:release-notes");
    await app.terminal.write(CTRL_J);
    await app.terminal.type("more words");
    await app.terminal.waitText("start the request on the /skill:release-notes line");
    await app.terminal.waitIdle();
    await app.capture("skills-flag-line");
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A read of the skill's file that fails loads nothing, and the work says the skill failed.
    rmSync(join(app.agent, "skills", "release-notes", "SKILL.md"));
    app.provider.reply(
      { tool: "read", arguments: { path: join(app.agent, "skills", "release-notes", "SKILL.md") } },
      "The skill is gone.",
    );
    await app.terminal.submit("draft the notes");
    await app.terminal.waitText("The skill is gone.");
    await app.terminal.waitIdle();
    const failed = await app.capture("skills-read-failed");
    assert.match(failed, /▸ \S+ skill release-notes failed/);
    assert.doesNotMatch(failed, /used skill/);
  } finally {
    release();
    await app.close();
  }
});
