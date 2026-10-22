import type { Widget } from "@pituitary/rpc";
import type { Task } from "../details.ts";
import { glyphs } from "../glyphs.ts";
import { counted } from "../plural.ts";
import { theme } from "../theme.ts";
import { Tasks } from "./tool-call.tsx";

/** Lines extensions placed on one side of the editor, one block per extension. */
export function Widgets({
  widgets,
  placement,
  rows = Number.POSITIVE_INFINITY,
}: {
  widgets: readonly Widget[];
  placement: Widget["placement"];
  rows?: number;
}) {
  const shown = widgets.filter((widget) => widget.placement === placement);
  const lines = shown.flatMap((widget) =>
    widget.lines.map((line, index) => ({ key: `${widget.key}-${index}`, line })),
  );
  if (lines.length === 0 || rows <= 0) return null;
  const kept = lines.slice(0, rows < lines.length ? Math.max(0, rows - 1) : rows);
  const hidden = lines.length - kept.length;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {kept.map(({ key, line }) => (
        <text key={key} fg={theme.dim} truncate wrapMode="none">
          {line}
        </text>
      ))}
      {hidden > 0 ? (
        <text fg={theme.dim} truncate wrapMode="none">
          … {counted(hidden, "more widget line")}
        </text>
      ) : null}
    </box>
  );
}

/** rpiv-todo's widget: its own drawing of the list `TodoPanel` reads from rpiv-todo's `todo` tool. */
const TODO_WIDGET = "rpiv-todos";

/**
 * The widgets to draw beside the todo panel, without a second drawing of the list it draws.
 * rpiv-todo replays its list from the whole branch, past what a compaction leaves in the
 * conversation, so its widget stays while the conversation holds no list.
 */
export function besideTodo(widgets: readonly Widget[], tasks: readonly Task[]): readonly Widget[] {
  return tasks.length === 0 ? widgets : widgets.filter((widget) => widget.key !== TODO_WIDGET);
}

/** Tasks shown in the panel before it summarises the rest. */
const PANEL_TASKS = 8;

/** The agent's todo list while any of it is still open. */
export function TodoPanel({ tasks, rows = PANEL_TASKS + 1 }: { tasks: readonly Task[]; rows?: number }) {
  const kept = tasks.filter((task) => task.status !== "deleted");
  const open = kept.filter((task) => task.status !== "completed");
  if (open.length === 0 || rows <= 0) return null;
  const done = kept.length - open.length;
  // Current work must stay visible even after a long prefix of completed tasks.
  const shown = [
    ...open.filter((task) => task.status === "in_progress"),
    ...open.filter((task) => task.status !== "in_progress"),
    ...kept.filter((task) => task.status === "completed"),
  ].slice(0, Math.max(0, Math.min(PANEL_TASKS, rows - 1)));
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text fg={theme.dim} truncate wrapMode="none">
        {glyphs.todo} todo {done}/{kept.length}
        {kept.length > shown.length ? ` · ${kept.length - shown.length} more` : ""}
      </text>
      <Tasks tasks={shown} compact />
    </box>
  );
}
