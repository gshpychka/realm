import { describe, expect, test } from "bun:test";
import { asTyped, parseUserText, skillsIn, typed } from "./user-text.ts";

/** A skill as Pi expands `/skill:name request` into a prompt. */
const expanded = (name: string, body: string, request?: string) =>
  `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>${request ? `\n\n${request}` : ""}`;

describe("parseUserText", () => {
  test("plain words are one text segment", () => {
    expect(parseUserText("fix the footer\n\nthen the header")).toEqual([
      { kind: "text", text: "fix the footer\n\nthen the header" },
    ]);
  });

  test("a skill with a request splits into the skill and the request", () => {
    expect(
      parseUserText(expanded("release-notes", "# Release notes\n\n1. Gather", "focus on the footer")),
    ).toEqual([
      {
        kind: "skill",
        name: "release-notes",
        location: "/skills/release-notes/SKILL.md",
        body: "# Release notes\n\n1. Gather",
      },
      { kind: "text", text: "focus on the footer" },
    ]);
  });

  test("a skill without a request is the skill alone", () => {
    const segments = parseUserText(expanded("lint", "Run the linter."));
    expect(segments).toEqual([
      { kind: "skill", name: "lint", location: "/skills/lint/SKILL.md", body: "Run the linter." },
    ]);
    expect(asTyped(segments)).toBe("/skill:lint");
  });

  test("a body that mentions its closing tag mid-paragraph keeps it", () => {
    const body = "Write </skill> literally\n</skill> inline is fine";
    expect(skillsIn(parseUserText(expanded("tags", body, "go")))[0]?.body).toBe(body);
  });

  test("queued skills taken back together are each read", () => {
    const joined = `${expanded("a", "Do a.", "first")}\n\n${expanded("b", "Do b.")}\n\nplain follow-up`;
    const segments = parseUserText(joined);
    expect(
      segments.map((segment) => (segment.kind === "skill" ? `skill ${segment.name}` : segment.text)),
    ).toEqual(["skill a", "first", "skill b", "plain follow-up"]);
    // Words after a skill read as its request, as a request Pi appended reads.
    expect(asTyped(segments)).toBe("/skill:a first\n\n/skill:b plain follow-up");
  });

  test("an unclosed or misquoted block stays as the operator's words", () => {
    const unclosed = '<skill name="x" location="/x/SKILL.md">\nbody without an end';
    expect(parseUserText(unclosed)).toEqual([{ kind: "text", text: unclosed }]);
    const misquoted = '<skill name=x location="/x/SKILL.md">\nbody\n</skill>';
    expect(parseUserText(misquoted)).toEqual([{ kind: "text", text: misquoted }]);
    // The closing tag must end the message or a paragraph.
    const trailing = '<skill name="x" location="/x/SKILL.md">\nbody\n</skill> and more';
    expect(parseUserText(trailing)).toEqual([{ kind: "text", text: trailing }]);
  });

  test('words that mention "<skill" mid-paragraph are not a skill', () => {
    const text = 'what does <skill name="x" location="y">\nmean\n</skill>';
    expect(parseUserText(text)).toEqual([{ kind: "text", text }]);
    expect(typed(text)).toBe(text);
  });

  test("a message without Pi's preamble keeps its whole body", () => {
    expect(skillsIn(parseUserText('<skill name="x" location="/x.md">\nJust do it.\n</skill>'))[0]?.body).toBe(
      "Just do it.",
    );
  });
});

describe("typed", () => {
  test("gives back the command the operator typed", () => {
    expect(typed(expanded("release-notes", "# Notes", "focus on the footer\nand the header"))).toBe(
      "/skill:release-notes focus on the footer\nand the header",
    );
    expect(typed("plain")).toBe("plain");
  });
});
