import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { cellsOf, normalMode, pastGrace, RUNNING, unscrolled, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";
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
const ALT_S_PICKS = "skills · the draft becomes the request";
const BACKSPACE = "\x7f";

const SKILL = `---
name: release-notes
description: Draft release notes from the merged pull requests
---

# Release notes

1. Gather the merged pull requests since the last tag.
2. Group them by area and write one line per change.
</skill> tags in a reply are written out as text.
`;

/** A skill Pi finds as a Markdown file of its own. */
const STANDUP = `---
name: standup
description: Write the standup update
---

List what changed since yesterday.
`;

/** A skill whose name is longer than a list's label column. */
const LONG_NAME = "a-very-long-skill-name-for-layout-checks";
const LONG_SKILL = `---
name: ${LONG_NAME}
description: Checks layout
---

Check the layout.
`;

/** A prompt template whose name starts the names of built-in commands. */
const CO = `---
description: short one
---
say co
`;

/** A prompt template that declares the argument it needs. */
const REVIEW = `---
description: Review the change
argument-hint: <focus>
---
Review this, focusing on $@
`;

/** `text` as pattern source that matches only itself. */
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A skill's chip as a capture's text reads it: its label between the chip's rounded ends. */
const CHIP = `${glyphs.chipStart}${glyphs.skill} skill release-notes${glyphs.chipEnd}`;

test("a chosen skill leads the draft, shows as a chip once sent, loads in the work, and comes back as typed, from the tree too", async () => {
  const app = await launchPi({
    skills: { "release-notes": SKILL, [LONG_NAME]: LONG_SKILL },
    prompts: { review: REVIEW, co: CO },
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
    // Typed in full, a skill still completes on enter, so a request can follow it, and nothing is sent.
    await app.terminal.type("/skill:release-notes");
    await app.terminal.waitText("tab enter complete");
    assert.doesNotMatch(await app.terminal.text(), /enter run/);
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /» \/skill:release-notes *$/m);
    assert.equal(app.provider.requests.length, 0);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A name too long for the list gives way to the request it asks for, which stays whole.
    await app.terminal.type("/skill:");
    await app.terminal.waitText("Checks layout");
    await app.terminal.waitIdle();
    const completingLong = await app.capture("skills-completion-long");
    assert.match(completingLong, /\/skill:a-very-long\S*… \[request\] +Checks layout/);
    // A name still being typed is left to the list: the editor's rule says nothing of it.
    assert.match(completingLong, /^━+\n » \/skill:$/m);
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
    await app.terminal.waitText(ALT_S_PICKS);
    await app.terminal.waitIdle();
    const picker = await app.capture("skills-picker");
    assert.match(picker, / release-notes · user +Draft release notes from the merged pull requests/);
    assert.match(picker, / a-very-long\S* · user +Checks layout/);
    await app.terminal.type("release");
    await app.terminal.waitText("1 of 2");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
    await app.terminal.waitIdle();
    // A skill Pi has leads the draft, and the editor's rule raises nothing.
    assert.match(await app.capture("skills-draft"), /^━+\n » \/skill:release-notes focus on the footer/m);
    // Choosing another skill takes the place of the one the draft starts with.
    await app.terminal.write(ALT_S);
    await app.terminal.waitText(ALT_S_PICKS);
    await pastGrace();
    await app.terminal.type("layout");
    await app.terminal.waitText("1 of 2");
    await app.terminal.keyboard.press("Enter");
    const swapped = await waitMatch(
      app.terminal,
      /» \/skill:a-very-long-skill-name-for-layout-checks focus on the footer/,
    );
    assert.equal(swapped.match(/\/skill:/g)?.length, 1);
    await app.terminal.write(ALT_S);
    await app.terminal.waitText(ALT_S_PICKS);
    await pastGrace();
    await app.terminal.type("release");
    await app.terminal.waitText("1 of 2");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("» /skill:release-notes focus on the footer");

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
    // The message shows the chip and the request; the instructions stay folded, a line of them
    // that starts with the closing tag too.
    assert.ok(sent.includes(`▌ ${CHIP} focus on the footer · ctrl+o`), sent);
    assert.doesNotMatch(
      sent,
      /<skill|Gather the merged|References are relative|tags in a reply|Group them by area/,
    );
    assert.match(sent, /▸ \S+ used skill release-notes$/m);

    // Expanded, the skill's file and instructions follow the message, and the read names the skill.
    await app.terminal.write(CTRL_O);
    await app.terminal.waitText("Gather the merged pull requests since the last tag.");
    await app.terminal.waitIdle();
    const expanded = await app.capture("skills-expanded");
    assert.match(expanded, /~\/\.pi\/agent\/skills\/release-notes\/SKILL\.md/);
    assert.match(expanded, /Group them by area[\s\S]*<\/skill> tags in a reply are written out as text\./);
    assert.match(expanded, new RegExp(`✓ ${glyphs.skill} skill release-notes`));
    await app.terminal.write(CTRL_O);
    await waitMatch(app.terminal, /^(?![\s\S]*Gather the merged)/);

    // Up brings the prompt back as typed, never the expanded skill.
    await app.terminal.write(UP);
    await app.terminal.waitText("↑ again for the previous prompt");
    await app.terminal.write(UP);
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
    await app.terminal.waitIdle();
    assert.match(await app.capture("skills-recalled"), /^━+\n » \/skill:release-notes focus on the footer/m);
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
    // Sent again from there, the skill loads as it did the first time, and a read that names its
    // file from home is that skill's too.
    app.provider.reply(
      { tool: "read", arguments: { path: "~/.pi/agent/skills/release-notes/SKILL.md" } },
      "Drafted them again.",
    );
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Drafted them again.");
    await app.terminal.waitIdle();
    const again = app.provider.requests.at(-2)?.prompt ?? "";
    assert.match(again, /^<skill name="release-notes" location="[^"]+SKILL\.md">/);
    assert.match(again, /focus on the footer$/);
    assert.match(await app.capture("skills-read-from-home"), /▸ \S+ used skill release-notes$/m);

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
    const forks = await app.capture("skills-fork-picker");
    assert.match(forks, /▶ \/skill:release-notes focus on the footer · skill +latest prompt/);
    // The session holds the prompt twice, on two branches; a fork offers only the branch it is on.
    assert.match(forks, / 1 of 1 /);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Forked into a new session");
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A prompt template named in full runs on enter, though built-in names start with its name.
    await app.terminal.type("/co");
    await waitMatch(app.terminal, /▶ \S+ \/co +short one/);
    await app.terminal.waitText("enter run");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reply to: say co");
  } finally {
    await app.close();
  }
});

test("queued skills show as chips, come back as typed, and still load when the run is interrupted; the editor flags what Pi would not expand", async () => {
  const app = await launchPi({ skills: { "release-notes": SKILL }, skillFiles: { standup: STANDUP } });
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
    // A second queued skill goes with it, in the same prompt.
    await app.terminal.submit("/skill:standup another ask");
    await app.terminal.waitText(
      `${glyphs.chipStart}${glyphs.skill} skill standup${glyphs.chipEnd} another ask`,
    );
    app.provider.reply("Picked up the notes.");
    await normalMode(app.terminal);
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("Picked up the notes.");
    await app.terminal.waitIdle();
    const interrupted = await app.capture("skills-interrupted");
    const resent = app.provider.requests[1]?.prompt ?? "";
    assert.match(resent, /^<skill name="release-notes" /);
    assert.match(resent, /its own changes quickly\n\n<skill name="standup" [\s\S]*another ask$/);
    assert.ok(interrupted.includes(`▌ ${CHIP} later please and group`), interrupted);
    assert.ok(
      interrupted.includes(`${glyphs.chipStart}${glyphs.skill} skill standup${glyphs.chipEnd} another ask`),
      interrupted,
    );
    assert.doesNotMatch(interrupted, /<skill|References are relative|List what changed/);
    // The key that shows the skills follows the message's last words, never alone on a row.
    assert.match(interrupted, /another ask +· ctrl\+o/);
    assert.doesNotMatch(interrupted, /^\W*· ctrl\+o/m);
    // The conversation wraps again at a narrower width once it has drawn there.
    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /^━{80}\n/m);
    await waitMatch(app.terminal, /^ +\S.*each team finds its own changes quickly *$/m);
    await waitMatch(app.terminal, /another ask +· ctrl\+o/);
    await app.terminal.waitIdle();
    const narrow = await app.capture("skills-interrupted-80");
    assert.doesNotMatch(narrow, /^\W*· ctrl\+o/m);
    await app.terminal.resize(100, 28);
    await waitMatch(app.terminal, /^━{100}\n/m);

    // Taken back, the message is both commands as typed, which the rule says Pi would not
    // expand again as one prompt.
    await app.terminal.write("i");
    await app.terminal.waitText("» ask pi");
    await app.terminal.write(UP);
    await app.terminal.waitText("↑ again for the previous prompt");
    await app.terminal.write(UP);
    await waitMatch(
      app.terminal,
      /» \/skill:release-notes later please[\s\S]*quickly\n *\n {3}\/skill:standup another ask/,
    );
    await app.terminal.waitText("a skill loads only from /skill: at the start of the draft");
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A skill sent without a request is the skill alone, which comes back as typed.
    app.provider.reply("Notes drafted.");
    await app.terminal.write(ALT_S);
    await app.terminal.waitText(ALT_S_PICKS);
    await pastGrace();
    await app.terminal.type("release");
    await app.terminal.waitText("1 of 2");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /» \/skill:release-notes *$/m);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Notes drafted.");
    await app.terminal.waitIdle();
    assert.match(app.provider.requests.at(-1)?.prompt ?? "", /^<skill name="release-notes"[\s\S]*<\/skill>$/);
    const alone = await app.capture("skills-alone");
    assert.match(alone, new RegExp(`▌ ${CHIP}( · ctrl\\+o)?$`, "m"));
    assert.doesNotMatch(alone, /<skill|Gather the merged|References are relative/);
    await app.terminal.write(UP);
    await app.terminal.waitText("↑ again for the previous prompt");
    await app.terminal.write(UP);
    await waitMatch(app.terminal, /» \/skill:release-notes *$/m);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // Pi expands only a leading skill command, and the editor's rule says so.
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
    // Choosing the skill again mends the draft into one Pi expands.
    await app.terminal.write(ALT_S);
    await app.terminal.waitText(ALT_S_PICKS);
    await pastGrace();
    await app.terminal.type("release");
    await app.terminal.waitText("1 of 2");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /^━+\n » \/skill:release-notes more words *\n━/m);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");
    // Pi sends a skill it has not loaded as typed, and the rule says so first.
    await app.terminal.type("/skill:nope fix it");
    await waitMatch(app.terminal, /^━━ .*nope.*━+\n » \/skill:nope fix it/m);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reply to: /skill:nope fix it");
    assert.equal(app.provider.requests.at(-1)?.prompt, "/skill:nope fix it");
    await app.terminal.type("/skill: fix it");
    await waitMatch(app.terminal, /^━━ .*name a skill.*━+\n » \/skill: fix it/m);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");

    // A SKILL.md Pi never loaded is an ordinary file to read.
    mkdirSync(join(app.cwd, "docs", "draft"), { recursive: true });
    writeFileSync(join(app.cwd, "docs", "draft", "SKILL.md"), "---\nname: draft\n---\nNot loaded.\n");
    app.provider.reply({ tool: "read", arguments: { path: "docs/draft/SKILL.md" } }, "Read the draft.");
    await app.terminal.submit("read the draft");
    await app.terminal.waitText("Read the draft.");
    await app.terminal.waitIdle();
    assert.match(await app.terminal.text(), /▸ \S+ 1 tool\b/);
    await app.terminal.write(CTRL_O);
    await app.terminal.waitText("docs/draft/SKILL.md");
    await app.terminal.waitIdle();
    const plain = await app.capture("skills-plain-read");
    assert.doesNotMatch(plain, /used skill|skill draft/);
    await app.terminal.write(CTRL_O);
    await waitMatch(app.terminal, /▸ \S+ 1 tool\b/);

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

    // A skill Pi loads from a Markdown file of its own is that skill's when a read names it
    // relative to the project, behind Pi's `@`.
    app.provider.reply(
      { tool: "read", arguments: { path: "@../.pi/agent/skills/standup.md" } },
      "Wrote the standup.",
    );
    await app.terminal.submit("write the standup");
    await app.terminal.waitText("Wrote the standup.");
    await app.terminal.waitIdle();
    assert.match(await app.capture("skills-standalone-read"), /▸ \S+ used skill standup\b/);

    // Words that only look like a skill Pi loaded are the operator's own, whether the tag comes
    // mid-paragraph or opens a block that never closes: no chip, and sent and recalled as typed.
    const lookalikes = [
      ['what does <skill name="x" location="y">', "mean", "</skill>"],
      ['<skill name="x" location="/x/SKILL.md">', "a body without an end"],
    ];
    for (const [index, lines] of lookalikes.entries()) {
      for (const [at, line] of lines.entries()) {
        if (at > 0) await app.terminal.write(CTRL_J);
        await app.terminal.type(line);
      }
      app.provider.reply(`Plain words ${index}.`);
      await app.terminal.keyboard.press("Enter");
      await app.terminal.waitText(`Plain words ${index}.`);
      await app.terminal.waitIdle();
      assert.equal(app.provider.requests.at(-1)?.prompt, lines.join("\n"));
      // The message's rows, after the mark that leads them: the transcript's, then the draft's.
      const rows = (mark: string) =>
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        new RegExp(`^ ${mark} ${lines.map(escaped).join(" *\\n {3}")} *$`, "m");
      const shown = unscrolled(await app.capture(`skills-lookalike-${index}`));
      assert.match(shown, rows("▌"));
      assert.doesNotMatch(shown, re`skill x${glyphs.chipEnd}`);
      await app.terminal.write(UP);
      await app.terminal.waitText("↑ again for the previous prompt");
      await app.terminal.write(UP);
      await waitMatch(app.terminal, rows("»"));
      await app.terminal.write(CTRL_C);
      await app.terminal.waitText("» ask pi");
    }
  } finally {
    release();
    await app.close();
  }
});
