import { useTerminalDimensions } from "@opentui/react";
import { dismiss, hintLine, MOVE, position, SELECTED, UNSELECTED } from "../hints.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { ellipsize } from "../text-width.ts";
import { palette, theme } from "../theme.ts";
import type { DetailIcon } from "./detail.tsx";

export interface Suggestion {
  label: string;
  detail?: string;
  /** Leads the label, such as the mark of a skill; rows without one keep its cells. */
  icon?: DetailIcon;
}

/** Cells a row's icon takes with the space after it. */
const ICON_CELLS = 2;

/** Rows the list shows before it scrolls, room permitting. */
const ROWS = 8;
/** Cells a label keeps before it is cut, and the gap after the label column. */
const LABEL_CELLS = 30;
const LABEL_GAP = 2;

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
  // The row's padding, mark and icons come first; the labels' column fits the longest, within bounds.
  const icons = items.some((item) => item.icon) ? ICON_CELLS : 0;
  const inner = columns - 2 - Bun.stringWidth(SELECTED) - icons;
  const labels = Math.max(
    1,
    Math.min(LABEL_CELLS, inner - LABEL_GAP, Math.max(...items.map((item) => Bun.stringWidth(item.label)))),
  );
  const width = labels + LABEL_GAP;
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
              width={width + Bun.stringWidth(SELECTED) + icons}
              flexShrink={0}
              wrapMode="none"
            >
              <span fg={chosen ? theme.assistant : theme.dim}>{chosen ? SELECTED : UNSELECTED}</span>
              {icons ? (
                <span fg={item.icon?.colour ?? theme.dim}>
                  {item.icon ? `${item.icon.glyph} ` : " ".repeat(ICON_CELLS)}
                </span>
              ) : null}
              {ellipsize(item.label, labels)}
            </text>
            {item.detail ? (
              <text selectable={false} fg={theme.dim} wrapMode="none" flexShrink={1}>
                {ellipsize(item.detail, inner - width)}
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
