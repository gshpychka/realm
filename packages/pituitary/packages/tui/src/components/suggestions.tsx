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
  /** Rows the list may take, so it fits the screen. */
  rows?: number;
}

/** What the word being typed could complete to, just above the editor, scrolled to the choice. */
export function Suggestions({ items, index, rows = ROWS }: SuggestionsProps) {
  if (items.length === 0) return null;
  const shown = Math.max(1, Math.min(ROWS, rows, items.length));
  const top = Math.max(0, Math.min(index - Math.floor(shown / 2), items.length - shown));
  const width = Math.min(32, Math.max(...items.map((item) => item.label.length)) + 2);
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
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
              fg={chosen ? theme.assistant : theme.tool}
              width={width}
              flexShrink={0}
              truncate
              wrapMode="none"
            >
              {item.label}
            </text>
            {item.detail ? (
              <text fg={theme.dim} truncate wrapMode="none" flexShrink={1}>
                {item.detail}
              </text>
            ) : null}
          </box>
        );
      })}
      <text fg={theme.dim} truncate wrapMode="none">
        tab completes · ↑↓ choose{items.length > shown ? ` · ${index + 1} of ${items.length}` : ""}
      </text>
    </box>
  );
}
