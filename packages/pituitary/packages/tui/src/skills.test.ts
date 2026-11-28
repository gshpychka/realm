import { describe, expect, test } from "bun:test";
import type { Command } from "./commands/commands.ts";
import { piSkills, skillFiles, skillFlag, withSkill } from "./skills.ts";

const commands: Command[] = [
  {
    name: "review",
    description: "review the diff",
    source: "prompt",
    path: "/home/me/.pi/agent/prompts/review.md",
  },
  {
    name: "skill:release-notes",
    description: "Draft release notes",
    source: "skill",
    scope: "project",
    path: "/work/app/.pi/skills/release-notes/SKILL.md",
  },
  {
    name: "skill:style",
    description: "House style",
    source: "skill",
    scope: "user",
    path: "/home/me/.pi/agent/skills/style.md",
  },
];

describe("piSkills", () => {
  test("keeps Pi's skills by the name /skill: takes, with their scope and file", () => {
    expect(piSkills(commands)).toEqual([
      {
        name: "release-notes",
        description: "Draft release notes",
        scope: "project",
        path: "/work/app/.pi/skills/release-notes/SKILL.md",
      },
      {
        name: "style",
        description: "House style",
        scope: "user",
        path: "/home/me/.pi/agent/skills/style.md",
      },
    ]);
  });
});

describe("skillFiles", () => {
  const skillOf = skillFiles(piSkills(commands), "/work/app", "/home/me");

  test("finds a skill by its file however the read names it", () => {
    expect(skillOf("/work/app/.pi/skills/release-notes/SKILL.md")).toBe("release-notes");
    expect(skillOf(".pi/skills/release-notes/SKILL.md")).toBe("release-notes");
    expect(skillOf("@.pi/skills/release-notes/../release-notes/SKILL.md")).toBe("release-notes");
    // A standalone Markdown skill is found too, which no file name gives away.
    expect(skillOf("~/.pi/agent/skills/style.md")).toBe("style");
  });

  test("any other file, another SKILL.md included, is no skill", () => {
    expect(skillOf("/work/app/README.md")).toBeNull();
    expect(skillOf("/elsewhere/skills/other/SKILL.md")).toBeNull();
  });
});

describe("withSkill", () => {
  test("leads the draft, which becomes the request, with the cursor's place at the end", () => {
    expect(withSkill("", "release-notes")).toBe("/skill:release-notes ");
    expect(withSkill("focus on the footer\nand the header", "release-notes")).toBe(
      "/skill:release-notes focus on the footer\nand the header",
    );
  });

  test("replaces the skill a draft already starts with", () => {
    expect(withSkill("/skill:style tidy this", "release-notes")).toBe("/skill:release-notes tidy this");
    expect(withSkill("/skill:style\ntidy this", "release-notes")).toBe("/skill:release-notes tidy this");
  });
});

describe("skillFlag", () => {
  const names = new Set(["release-notes", "style"]);

  test("a leading skill Pi has, with or without a request, is fine", () => {
    expect(skillFlag("/skill:release-notes", names)).toBeNull();
    expect(skillFlag("/skill:release-notes focus on the footer", names)).toBeNull();
    expect(skillFlag("plain words", names)).toBeNull();
  });

  test("a name still being typed is left to the completion list", () => {
    expect(skillFlag("/skill:rel", names)).toBeNull();
    expect(skillFlag("/skill:", names)).toBeNull();
  });

  test("a skill Pi has not loaded goes as typed", () => {
    expect(skillFlag("/skill:nope fix it", names)).toBe("Pi has no skill nope, so it goes as typed");
    expect(skillFlag("/skill: fix it", names)).toBe("name a skill straight after /skill:");
  });

  test("a /skill: anywhere but the start is sent as typed", () => {
    const flag = "a skill loads only from /skill: at the start of the draft";
    expect(skillFlag("please use /skill:style", names)).toBe(flag);
    expect(skillFlag(" /skill:style", names)).toBe(flag);
    expect(skillFlag("/skill:release-notes then /skill:style", names)).toBe(flag);
    expect(skillFlag("see a/skill:style path", names)).toBeNull();
  });
});
