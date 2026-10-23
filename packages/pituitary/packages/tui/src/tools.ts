import type { Entry, ToolView } from "@pituitary/session";
import { detailsOf, type Task } from "./details.ts";
import type { Glyph } from "./glyphs.ts";
import { counted } from "./plural.ts";

/** A tool call's one-line heading: what it acted on, in the terms of that tool. */
export interface Heading {
  title: string;
  detail: string;
}

/** Output lines a collapsed call shows, by tool, as pi's own renderers show them. */
const PREVIEW_LINES = new Map([
  ["bash", 5],
  ["grep", 15],
  ["find", 20],
  ["ls", 20],
]);
const DEFAULT_PREVIEW = 10;
/** Lines an expanded call shows before it cuts the rest. */
const EXPANDED_LINES = 400;

/** Which end of the output a collapsed call keeps: a command's latest lines matter most. */
const TAIL = new Set(["bash"]);

type Args = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function range(args: Args): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const from = offset ?? 1;
  return limit === undefined ? `:${from}` : `:${from}-${from + limit - 1}`;
}

/** Where a search looked: the pattern, and the path when the call names one. */
const searched = (args: Args) => `${text(args.pattern)}${args.path ? ` in ${text(args.path)}` : ""}`;

/** How many lines a read returned, when it returned any. */
function readLines(tool: ToolView): string {
  const lines = tool.output ? tool.output.replace(/\n+$/, "").split("\n").length : 0;
  return lines > 0 ? ` · ${counted(lines, "line")}` : "";
}

/** How many questions the model asks, when it asks any. */
function questions(args: Args): string {
  const count = Array.isArray(args.questions) ? args.questions.length : 0;
  return count > 0 ? counted(count, "question") : "";
}

/** Each tool's heading from its arguments and its call, by tool name. */
const HEADINGS = new Map<string, (args: Args, tool: ToolView) => Heading>([
  ["read", (args, tool) => ({ title: "read", detail: `${text(args.path)}${range(args)}${readLines(tool)}` })],
  [
    "write",
    (args) => ({
      title: "write",
      detail: `${text(args.path)} (${counted(text(args.content).split("\n").length, "line")})`,
    }),
  ],
  ["edit", (args) => ({ title: "edit", detail: text(args.path) })],
  ["bash", (args) => ({ title: "$", detail: text(args.command) })],
  ["grep", (args) => ({ title: "grep", detail: searched(args) })],
  ["find", (args) => ({ title: "find", detail: searched(args) })],
  ["ls", (args) => ({ title: "ls", detail: text(args.path) || "." })],
  ["todo", (args) => ({ title: "todo", detail: text(args.action) })],
  ["ask_user_question", (args) => ({ title: "ask", detail: questions(args) })],
  ["subagent", (args) => ({ title: "subagent", detail: text(args.description) || text(args.prompt) })],
  ["web_search", (args) => ({ title: "search", detail: text(args.query) })],
  ["plan_mode_complete", () => ({ title: "plan", detail: "ready" })],
]);

/** A call's heading in its tool's own terms, or its arguments on one line for a tool with none. */
export function heading(tool: ToolView): Heading {
  const args = tool.args as Args;
  return HEADINGS.get(tool.name)?.(args, tool) ?? { title: tool.name || "tool", detail: compact(args) };
}

/** Icons of the tools a heading names, by tool name. */
const TOOL_GLYPHS = new Map<string, Glyph>([
  ["read", "read"],
  ["write", "write"],
  ["edit", "edit"],
  ["grep", "grep"],
  ["find", "find"],
  ["ls", "ls"],
  ["todo", "todo"],
  ["ask_user_question", "ask"],
  ["plan_mode_question", "ask"],
  ["plan_mode_complete", "plan"],
  ["subagent", "agents"],
  ["get_subagent_result", "agents"],
  ["steer_subagent", "agents"],
  ["web_search", "web"],
  ["fetch_content", "web"],
  ["get_search_content", "web"],
  ["source_check", "web"],
]);

/** The icon beside a tool call's heading; a command's `$` is its own. */
export function toolGlyph(name: string): Glyph | null {
  if (name === "bash") return null;
  return TOOL_GLYPHS.get(name) ?? "tool";
}

/** Arguments on one line, long values cut, for a tool with no heading of its own. */
export function compact(args: Args, width = 80): string {
  const parts = Object.entries(args).map(([key, value]) => {
    const shown = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}=${shown && shown.length > 40 ? `${shown.slice(0, 39)}…` : shown}`;
  });
  const line = parts.join(" ");
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export interface Preview {
  lines: string[];
  /** Lines left out, which expanding the call shows. */
  hidden: number;
}

/** The part of a call's output shown collapsed, or most of it expanded. */
export function preview(tool: ToolView, expanded: boolean): Preview {
  const source =
    tool.name === "write" && !tool.output.trim() ? text((tool.args as Args).content) : tool.output;
  const all = source.replace(/\n+$/, "").split("\n");
  if (all.length === 1 && all[0] === "") return { lines: [], hidden: 0 };
  const limit = expanded ? EXPANDED_LINES : (PREVIEW_LINES.get(tool.name) ?? DEFAULT_PREVIEW);
  if (all.length <= limit) return { lines: all, hidden: 0 };
  const lines = TAIL.has(tool.name) ? all.slice(-limit) : all.slice(0, limit);
  return { lines, hidden: all.length - limit };
}

/** The todo list as the latest `todo` call left it, without deleted tasks. */
export function latestTasks(entries: readonly Entry[]): Task[] {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind !== "assistant") continue;
    for (const tool of entry.tools.toReversed()) {
      const details = detailsOf(tool);
      if (details?.kind === "tasks") return details.tasks.filter((task) => task.status !== "deleted");
    }
  }
  return [];
}

/** Calls under this long show no duration, except commands, whose time is always worth seeing. */
const NOTABLE_MS = 1000;

/** How long a call took, when that is worth showing. */
export function took(tool: ToolView): string | null {
  if (tool.startedAt === undefined || tool.endedAt === undefined) return null;
  const ms = tool.endedAt - tool.startedAt;
  if (tool.name !== "bash" && ms < NOTABLE_MS) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Filetypes the bundled tree-sitter grammars highlight, by extension. */
const FILETYPES = new Map(
  Object.entries({
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    md: "markdown",
    zig: "zig",
  }),
);

/** The filetype to highlight a file's content as, when its grammar is available. */
export function filetypeOf(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension ? FILETYPES.get(extension) : undefined;
}

/** The filetype a read or write call's output highlights as: the file's, when the call succeeded. */
export function filetypeOfCall(tool: ToolView): string | undefined {
  if ((tool.name !== "read" && tool.name !== "write") || tool.state === "error") return undefined;
  return filetypeOf(text((tool.args as Args).path));
}
