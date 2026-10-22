import type { Widget } from "@pituitary/rpc";
import type { Task } from "../details.ts";
import { glyphs } from "../glyphs.ts";
import { theme } from "../theme.ts";
import { Tasks } from "./tool-call.tsx";

/** Lines extensions placed on one side of the editor, one block per extension. */
export function Widgets({
  widgets,
  placement,
}: {
  widgets: readonly Widget[];
  placement: Widget["placement"];
}) {
  const shown = widgets.filter((widget) => widget.placement === placement);
  if (shown.length === 0) return null;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {shown.flatMap((widget) =>
        widget.lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: widget lines are identified by position
          <text key={`${widget.key}-${index}`} fg={theme.dim} truncate wrapMode="none">
            {line}
          </text>
        )),
      )}
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
export function TodoPanel({ tasks }: { tasks: readonly Task[] }) {
  const open = tasks.filter((task) => task.status !== "completed");
  if (open.length === 0) return null;
  const done = tasks.length - open.length;
  const shown = tasks.slice(0, PANEL_TASKS);
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text fg={theme.dim}>
        {glyphs.todo} todo {done}/{tasks.length}
        {tasks.length > shown.length ? ` · ${tasks.length - shown.length} more` : ""}
      </text>
      <Tasks tasks={shown} />
    </box>
  );
}
