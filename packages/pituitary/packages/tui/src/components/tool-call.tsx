import type { ToolView } from "@pituitary/session";
import { memo } from "react";
import { type Answer, type Details, detailsOf, fullOutputOf, type Task } from "../details.ts";
import { glyphs } from "../glyphs.ts";
import { KeyHint } from "../keymap-context.tsx";
import { counted } from "../plural.ts";
import { palette, theme } from "../theme.ts";
import { filetypeOfCall, heading, preview, took, toolGlyph } from "../tools.ts";
import { Markdown, syntax } from "./markdown.tsx";

const STATE = {
  running: { glyph: "◌", colour: theme.tool },
  ok: { glyph: "✓", colour: theme.ok },
  error: { glyph: "✗", colour: theme.error },
} as const;

export interface ToolCallProps {
  tool: ToolView;
  /** Shows the whole output, as ctrl+o asks. */
  expanded: boolean;
}

/** One tool call: what it acted on, how it ended, and as much of its result as fits. */
export const ToolCall = memo(function ToolCall({ tool, expanded }: ToolCallProps) {
  const { title, detail } = heading(tool);
  const icon = toolGlyph(tool.name);
  const state = STATE[tool.state];
  const elapsed = took(tool);
  return (
    <box flexDirection="column">
      <text selectable>
        <span fg={state.colour}>{tool.streaming !== undefined ? "…" : state.glyph} </span>
        <span fg={theme.tool}>{icon ? `${glyphs[icon]} ${title}` : title}</span>
        <span fg={theme.assistant}> {detail}</span>
        {elapsed ? <span fg={theme.dim}> · {elapsed}</span> : null}
      </text>
      <box flexDirection="column" paddingLeft={2}>
        <Body tool={tool} expanded={expanded} />
      </box>
    </box>
  );
});

/** A call's result: drawn in the tool's own way where pituitary knows it, as output otherwise. */
function Body({ tool, expanded }: ToolCallProps) {
  // The file is the model's to read; pi's own view shows the call and leaves the text folded.
  if (tool.name === "read" && !expanded && tool.state !== "error") return null;
  const details = drawn(tool);
  return details ? (
    <Drawn details={details} tool={tool} expanded={expanded} />
  ) : (
    <Output tool={tool} expanded={expanded} />
  );
}

/**
 * What `tool` shows in its own way. A failed edit shows its error; before an edit runs, and
 * while a permission prompt waits on it, the change comes from the call itself.
 */
function drawn(tool: ToolView): Details | null {
  if (tool.name !== "edit") return detailsOf(tool);
  if (tool.state === "error") return null;
  const proposed = tool.state === "running" ? proposedDiff(tool.args) : null;
  return detailsOf(tool) ?? (proposed ? { kind: "diff", diff: proposed } : null);
}

function Drawn({ details, tool, expanded }: { details: Details } & ToolCallProps) {
  switch (details.kind) {
    case "diff":
      return <Diff diff={details.diff} expanded={expanded} />;
    case "tasks":
      return <Tasks tasks={details.tasks} selectable />;
    case "subagent":
      return <Subagent agent={details} />;
    case "search":
      return <Search search={details} tool={tool} expanded={expanded} />;
    case "answers":
      return <Answers answers={details.answers} />;
    case "cancelled":
      return (
        <text fg={theme.dim} selectable>
          cancelled
        </text>
      );
    case "plan":
      return <Markdown content={details.plan} />;
    default:
      return details satisfies never;
  }
}

function Output({ tool, expanded }: ToolCallProps) {
  const { lines, hidden } = preview(tool, expanded);
  const filetype = filetypeOfCall(tool);
  if (filetype && lines.length > 0) {
    return (
      <box flexDirection="column">
        <code content={lines.join("\n")} filetype={filetype} syntaxStyle={syntax} conceal={false} />
        {hidden > 0 ? <More count={hidden} /> : null}
      </box>
    );
  }
  // A command keeps its latest lines, so what was cut comes before them.
  const more = hidden > 0 ? <More count={hidden} /> : null;
  const tail = tool.name === "bash";
  const full = fullOutputOf(tool);
  return (
    <box flexDirection="column">
      {tail ? more : null}
      {lines.length > 0 ? (
        <text fg={tool.state === "error" ? theme.error : theme.dim} selectable>
          {lines.join("\n")}
        </text>
      ) : null}
      {tail ? null : more}
      {full ? (
        <text fg={theme.dim} selectable>
          full output: {full}
        </text>
      ) : null}
    </box>
  );
}

function More({ count }: { count: number }) {
  return (
    <text fg={theme.dim}>
      … {counted(count, "more line")}
      <KeyHint action="app.tools.expand" />
    </text>
  );
}

/** Lines of a diff shown before it folds. */
const DIFF_LINES = 60;

/** The change an edit call asks for, as diff lines, from the text it replaces and the text it puts in. */
function proposedDiff(args: Record<string, unknown>): string | null {
  const edits = Array.isArray(args.edits)
    ? (args.edits as { oldText?: unknown; newText?: unknown }[])
    : [args];
  const lines: string[] = [];
  for (const edit of edits) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue;
    if (lines.length > 0) lines.push("  …");
    for (const line of edit.oldText.split("\n")) lines.push(`- ${line}`);
    for (const line of edit.newText.split("\n")) lines.push(`+ ${line}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

interface Tone {
  fg: string;
  bg?: string;
}

/** How a diff line draws, by its sign; a line of context draws dim. */
const DIFF_TONES = new Map<string, Tone>([
  ["+", { fg: palette.green, bg: "#32361a" }],
  ["-", { fg: palette.red, bg: "#3c1f1e" }],
]);
const CONTEXT_TONE: Tone = { fg: theme.dim };

function Diff({ diff, expanded }: { diff: string; expanded: boolean }) {
  const all = diff.split("\n");
  const lines = expanded ? all : all.slice(0, DIFF_LINES);
  const hidden = all.length - lines.length;
  return (
    <box flexDirection="column">
      <text selectable>
        {lines.map((line, index) => {
          const tone = DIFF_TONES.get(line.charAt(0)) ?? CONTEXT_TONE;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are identified by position
            <span key={index} fg={tone.fg} bg={tone.bg}>
              {line || " "}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          );
        })}
      </text>
      {hidden > 0 ? <More count={hidden} /> : null}
    </box>
  );
}

const TASK_MARK = {
  completed: { glyph: "✓", colour: theme.dim },
  in_progress: { glyph: "▸", colour: palette.yellow },
  pending: { glyph: "○", colour: theme.assistant },
  deleted: { glyph: "×", colour: theme.dim },
} as const;

/** The todo list; `selectable` where it is the todo call's own result. */
export function Tasks({
  tasks,
  selectable = false,
  compact = false,
}: {
  tasks: readonly Task[];
  selectable?: boolean;
  compact?: boolean;
}) {
  return (
    <box flexDirection="column">
      {tasks.flatMap((task) => {
        if (task.status === "deleted") return [];
        const mark = TASK_MARK[task.status] ?? TASK_MARK.pending;
        const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
        return [
          <text
            key={String(task.id)}
            fg={mark.colour}
            selectable={selectable}
            truncate={compact}
            wrapMode={compact ? "none" : "word"}
          >
            {mark.glyph} {label}
          </text>,
        ];
      })}
    </box>
  );
}

function Subagent({ agent }: { agent: Extract<Details, { kind: "subagent" }> }) {
  const meta = [
    agent.status,
    agent.toolUses === undefined ? null : `${agent.toolUses} tool calls`,
    agent.tokens === undefined ? null : `${glyphs.tokens} ${(agent.tokens / 1000).toFixed(1)}k tokens`,
    agent.durationMs === undefined ? null : `${(agent.durationMs / 1000).toFixed(1)}s`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <box flexDirection="column">
      <text fg={theme.assistant} selectable>
        {agent.name}
        {agent.description ? <span fg={theme.dim}>: {agent.description}</span> : null}
      </text>
      {meta ? (
        <text fg={theme.dim} selectable>
          {meta}
        </text>
      ) : null}
      {agent.activity === undefined ? null : (
        <text fg={theme.dim} selectable>
          {agent.activity}
        </text>
      )}
      {agent.error === undefined ? null : (
        <text fg={theme.error} selectable>
          {agent.error}
        </text>
      )}
    </box>
  );
}

function Search({
  search,
  tool,
  expanded,
}: { search: Extract<Details, { kind: "search" }> } & ToolCallProps) {
  return (
    <box flexDirection="column">
      <text fg={theme.dim} selectable>
        {search.phase}
      </text>
      {search.curatorUrl === undefined ? null : (
        <text fg={palette.blue} selectable>
          review the results at {search.curatorUrl}
        </text>
      )}
      {tool.state === "running" ? null : <Output tool={tool} expanded={expanded} />}
    </box>
  );
}

function Answers({ answers }: { answers: readonly Answer[] }) {
  return (
    <box flexDirection="column">
      {answers.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: answers are identified by position
        <text key={index} selectable>
          <span fg={theme.dim}>{item.question ?? "?"} → </span>
          <span fg={theme.assistant}>{item.answer ?? ""}</span>
        </text>
      ))}
    </box>
  );
}
