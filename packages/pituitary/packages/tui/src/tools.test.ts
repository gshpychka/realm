import { describe, expect, test } from "bun:test";
import type { Entry, ToolView } from "@pituitary/rpc";
import { compact, filetypeOf, heading, latestTasks, preview, took, toolGlyph } from "./tools.ts";

const tool = (
  name: string,
  args: Record<string, unknown>,
  output = "",
  extra: Partial<ToolView> = {},
): ToolView => ({
  id: "t",
  name,
  args,
  state: "ok",
  output,
  ...extra,
});

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

describe("heading", () => {
  test("names what each built-in tool acted on", () => {
    expect(heading(tool("read", { path: "a.ts", offset: 10, limit: 5 }))).toEqual({
      title: "read",
      detail: "a.ts:10-14",
    });
    expect(heading(tool("write", { path: "b.md", content: "x\ny" }))).toEqual({
      title: "write",
      detail: "b.md (2 lines)",
    });
    expect(heading(tool("bash", { command: "ls -1" }))).toEqual({ title: "$", detail: "ls -1" });
    expect(heading(tool("grep", { pattern: "TODO", path: "src" }))).toEqual({
      title: "grep",
      detail: "TODO in src",
    });
    expect(heading(tool("ls", {}))).toEqual({ title: "ls", detail: "." });
  });

  test("a tool it does not know shows its arguments on one line", () => {
    expect(heading(tool("mcp", { server: "gh", tool: "issues" }))).toEqual({
      title: "mcp",
      detail: "server=gh tool=issues",
    });
  });

  test("long argument values are cut", () => {
    expect(compact({ query: "x".repeat(60) })).toBe(`query=${"x".repeat(39)}…`);
  });
});

describe("preview", () => {
  test("a collapsed read shows its first lines and counts the rest", () => {
    const shown = preview(tool("read", { path: "a" }, lines(25)), false);
    expect(shown.lines[0]).toBe("line 1");
    expect(shown.lines).toHaveLength(10);
    expect(shown.hidden).toBe(15);
  });

  test("a collapsed command shows its latest lines", () => {
    const shown = preview(tool("bash", { command: "x" }, lines(25)), false);
    expect(shown.lines).toEqual(["line 21", "line 22", "line 23", "line 24", "line 25"]);
  });

  test("an expanded call shows everything up to the cap", () => {
    expect(preview(tool("read", { path: "a" }, lines(25)), true)).toEqual({
      lines: lines(25).split("\n"),
      hidden: 0,
    });
  });

  test("a write shows the content it wrote", () => {
    expect(preview(tool("write", { path: "a", content: "one\ntwo" }), false).lines).toEqual(["one", "two"]);
  });

  test("no output is no lines", () => {
    expect(preview(tool("ls", {}, ""), false)).toEqual({ lines: [], hidden: 0 });
  });
});

describe("latestTasks", () => {
  const todo = (tasks: unknown[]): Entry => ({
    kind: "assistant",
    id: "a",
    text: "",
    thinking: "",
    done: true,
    tools: [tool("todo", {}, "", { details: { tasks } })],
  });

  test("reads the list the latest todo call left, without deleted tasks", () => {
    const entries = [
      todo([{ id: 1, subject: "old", status: "pending" }]),
      todo([
        { id: 1, subject: "read", status: "completed" },
        { id: 2, subject: "gone", status: "deleted" },
        { id: 3, subject: "write", status: "in_progress" },
      ]),
    ];
    expect(latestTasks(entries).map((task) => task.subject)).toEqual(["read", "write"]);
  });

  test("is empty with no todo call", () => {
    expect(latestTasks([])).toEqual([]);
  });
});

describe("took", () => {
  test("prints the time between start and end", () => {
    expect(took(tool("bash", {}, "", { startedAt: 1000, endedAt: 3450 }))).toBe("2.5s");
    expect(took(tool("bash", {}))).toBeNull();
  });

  test("a quick call other than a command shows no duration", () => {
    expect(took(tool("read", {}, "", { startedAt: 0, endedAt: 200 }))).toBeNull();
    expect(took(tool("read", {}, "", { startedAt: 0, endedAt: 1500 }))).toBe("1.5s");
    expect(took(tool("bash", {}, "", { startedAt: 0, endedAt: 50 }))).toBe("0.1s");
  });
});

describe("filetypeOf", () => {
  test("names the grammar for a file it can highlight", () => {
    expect(filetypeOf("src/a.tsx")).toBe("typescript");
    expect(filetypeOf("README.md")).toBe("markdown");
    expect(filetypeOf("main.rs")).toBeUndefined();
    expect(filetypeOf("Makefile")).toBeUndefined();
  });
});

describe("toolGlyph", () => {
  test("gives each tool its icon, and a command none beside its `$`", () => {
    expect(toolGlyph("read")).toBe("read");
    expect(toolGlyph("edit")).toBe("edit");
    expect(toolGlyph("fetch_content")).toBe("web");
    expect(toolGlyph("steer_subagent")).toBe("agents");
    expect(toolGlyph("plan_mode_complete")).toBe("plan");
    expect(toolGlyph("bash")).toBeNull();
  });

  test("a tool it does not know takes the generic icon", () => {
    expect(toolGlyph("mcp")).toBe("tool");
    expect(toolGlyph("constructor")).toBe("tool");
  });
});
