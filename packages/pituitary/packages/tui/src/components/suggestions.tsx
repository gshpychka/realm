import { useTerminalDimensions } from "@opentui/react";
import { dismiss, hintLine, MOVE, position } from "../hints.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { ellipsize } from "../text-width.ts";
import { palette, theme } from "../theme.ts";

export interface Suggestion {
  label: string;
  detail?: string;
}

/** Rows the list shows before it scrolls, room permitting. */
const ROWS = 8;

export interface SuggestionsProps {
  items: readonly Suggestion[];
  index: number;
  /** Enter runs the chosen command; otherwise it completes the draft, as tab does. */
  runs: boolean;
  /** Rows the list may take, so it fits the screen. */
  rows?: number;
}

/** What the word being typed could complete to, just above the editor, scrolled to the choice. */
export function Suggestions({ items, index, runs, rows = ROWS }: SuggestionsProps) {
  const { width: columns } = useTerminalDimensions();
  const close = useKeyHint("app.interrupt");
  if (items.length === 0) return null;
  const shown = Math.max(1, Math.min(ROWS, rows, items.length));
  const top = Math.max(0, Math.min(index - Math.floor(shown / 2), items.length - shown));
  const width = Math.min(32, Math.max(...items.map((item) => Bun.stringWidth(item.label))) + 2);
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.bg}>
      {items.slice(top, top + shown).map((item, offset) => {
        const chosen = top + offset === index;
        return (
          <box
            key={item.label}
            flexDirection="row"
            height={1}
            backgroundColor={chosen ? palette.rule : undefined}
          >
            <text
              selectable={false}
              fg={chosen ? theme.assistant : theme.tool}
              width={width}
              flexShrink={0}
              truncate
              wrapMode="none"
            >
              {item.label}
            </text>
            {item.detail ? (
              <text selectable={false} fg={theme.dim} wrapMode="none" flexShrink={1}>
                {ellipsize(item.detail, columns - 2 - width)}
              </text>
            ) : null}
          </box>
        );
      })}
      <text selectable={false} fg={theme.dim} wrapMode="none">
        {hintLine(
          runs
            ? [MOVE, ["tab", "complete"], ["enter", "run"], dismiss(close, "close")]
            : [MOVE, ["tab enter", "complete"], dismiss(close, "close")],
          items.length > shown ? position(index, items.length) : null,
          columns - 2,
        )}
      </text>
    </box>
  );
}
