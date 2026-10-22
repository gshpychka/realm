import { describe, expect, test } from "bun:test";
import { mentionAt, rank } from "../files.ts";
import { BUILTINS, builtin, type Command, suggest } from "./commands.ts";
import { ago } from "./run-command.ts";

describe("ago", () => {
  test("spells the unit out", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(ago(new Date(now - 20_000), now)).toBe("just now");
    expect(ago(new Date(now - 60_000), now)).toBe("1 minute ago");
    expect(ago(new Date(now - 5 * 60_000), now)).toBe("5 minutes ago");
    expect(ago(new Date(now - 3 * 3_600_000), now)).toBe("3 hours ago");
    expect(ago(new Date(now - 72 * 3_600_000), now)).toBe("3 days ago");
  });
});

const extra: Command[] = [
  { name: "review", description: "", source: "prompt" },
  { name: "plan", description: "", source: "extension" },
];

describe("builtin", () => {
  test("recognises a built-in command and what follows it", () => {
    expect(builtin("/model fake/fake-model-2")).toEqual({ name: "model", args: "fake/fake-model-2" });
    expect(builtin("/compact keep the plan")).toEqual({ name: "compact", args: "keep the plan" });
    expect(builtin("/new")).toEqual({ name: "new", args: "" });
  });

  test("leaves anything else to pi", () => {
    expect(builtin("/review focus on tests")).toBeNull();
    expect(builtin("/skill:lint")).toBeNull();
    expect(builtin("model")).toBeNull();
  });

  test("recognises stock commands, including those handed to pi itself", () => {
    expect(builtin("/tree")).toEqual({ name: "tree", args: "" });
    expect(builtin("/login anthropic")).toEqual({ name: "login", args: "anthropic" });
  });
});

describe("suggest", () => {
  const all = [...BUILTINS, ...extra];

  test("offers names starting with what is typed, then names containing it", () => {
    expect(suggest("/re", all)?.map((command) => command.name)).toEqual([
      "resume",
      "reload",
      "review",
      "tree",
      "share",
    ]);
    expect(suggest("/ode", all)?.map((command) => command.name)).toEqual(["model", "scoped-models"]);
  });

  test("offers everything for a bare slash", () => {
    expect(suggest("/", all)).toHaveLength(all.length);
  });

  test("stops once arguments begin, and outside a command", () => {
    expect(suggest("/model fake", all)).toBeNull();
    expect(suggest("hello /mo", all)).toBeNull();
  });
});

describe("rank", () => {
  const paths = ["src/payouts/limits.ts", "src/limits/index.ts", "docs/payouts.md", "test/limits.test.ts"];

  test("a match inside the file name comes first", () => {
    expect(rank("limits", paths)[0]).toBe("src/payouts/limits.ts");
  });

  test("letters in order across the path still match", () => {
    expect(rank("dpm", paths)).toEqual(["docs/payouts.md"]);
  });

  test("letters out of order do not", () => {
    expect(rank("zzz", paths)).toEqual([]);
  });
});

describe("mentionAt", () => {
  test("finds the @path under the cursor", () => {
    expect(mentionAt("look at @src/li", 15)).toEqual({ query: "src/li", start: 8, end: 15 });
    expect(mentionAt("@a", 2)).toEqual({ query: "a", start: 0, end: 2 });
  });

  test("ignores an @ inside a word", () => {
    expect(mentionAt("mail me@host", 12)).toBeNull();
  });

  test("completes a quoted path with spaces and replaces its remaining suffix", () => {
    expect(mentionAt('look @"docs/user guide.md" next', 15)).toEqual({
      query: "docs/use",
      start: 5,
      end: 26,
    });
    expect(mentionAt('@"docs/user ', 12)).toEqual({ query: "docs/user ", start: 0, end: 12 });
    expect(mentionAt('@"docs/user guide.md" ', 21)).toBeNull();
  });
});
