import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { RUNNING, waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const UP = "\x1b[A";
const CTRL_C = "\x03";
const CTRL_O = "\x0f";
const ALT_S = "\x1bs";
const ALT_F = "\x1bf";

const SKILL = `---
name: release-notes
description: Draft release notes from the merged pull requests
---

# Release notes

1. Gather the merged pull requests since the last tag.
2. Group them by area and write one line per change.
`;

/** A skill's chip as a capture's text reads it: its label between the chip's rounded ends. */
const CHIP = `${glyphs.chipStart}${glyphs.skill} skill release-notes${glyphs.chipEnd}`;

test("a chosen skill leads the draft, shows as a chip once sent, loads in the work, and comes back as typed", async () => {
  const app = await launchPi({ skills: { "release-notes": SKILL } });
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

    // The list of skills puts the chosen one before what the draft holds, which becomes its request.
    await app.terminal.type("focus on the footer");
    await app.terminal.waitText("» focus on the footer");
    await app.terminal.write(ALT_S);
    await app.terminal.waitText("skills · the draft becomes the request");
    await app.terminal.waitIdle();
    const picker = await app.capture("skills-picker");
    assert.match(picker, /▶ release-notes +user Draft release notes from the merged pull requests/);
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
      /▶ \/skill:release-notes focus on the footer +latest prompt/,
    );
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Forked into a new session");
    await app.terminal.waitText("» /skill:release-notes focus on the footer");
  } finally {
    await app.close();
  }
});

test("a queued skill shows as a chip and comes back into the draft as typed; a /skill: past the start is flagged", async () => {
  const app = await launchPi({ skills: { "release-notes": SKILL } });
  try {
    let release = () => {};
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
    release();
    await app.terminal.waitText("Working on it.");
    await app.terminal.waitIdle();

    // Pi expands only a leading skill command, and the editor's rule says so.
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("» ask pi");
    await app.terminal.type("please use /skill:release-notes");
    await app.terminal.waitText("a skill loads only from /skill: at the start of the draft");
    await app.terminal.waitIdle();
    await app.capture("skills-flag");
  } finally {
    await app.close();
  }
});
