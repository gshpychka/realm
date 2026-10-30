import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useRef, useState } from "react";
import { palette, theme } from "../theme.ts";
import { Detail, type DetailIcon } from "./detail.tsx";

export interface PickItem {
  label: string;
  detail?: string;
  /** Leads the detail. */
  icon?: DetailIcon;
  value: string;
  /** Marks the item that is in effect now, such as the current model. */
  current?: boolean;
}

/** A choice the operator makes from a list, and what follows it. */
export interface PickerSpec {
  title: string;
  items: readonly PickItem[];
  onPick(value: string): void;
  /** Runs when the operator closes the list without picking. */
  onCancel?(): void;
  /** What the filter starts with, as `/model sonnet` narrows the list to match. */
  query?: string;
}

/** Rows the list shows before it scrolls, room permitting. */
const ROWS = 10;

function matchingItems(items: readonly PickItem[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      const haystack = `${item.label} ${item.detail ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort(
      (a, b) =>
        Number(words.every((word) => b.label.toLowerCase().includes(word))) -
        Number(words.every((word) => a.label.toLowerCase().includes(word))),
    );
}

/** A filterable list in the editor's place: type to narrow, arrows to move, enter to pick. */
export function Picker({
  spec,
  onClose,
  rows = ROWS,
  compact = false,
}: {
  spec: PickerSpec;
  onClose(): void;
  rows?: number;
  compact?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const input = useRef<InputRenderable>(null);
  const [query, setQuery] = useState(spec.query ?? "");
  const [selected, setSelected] = useState(() =>
    spec.query
      ? 0
      : Math.max(
          0,
          spec.items.findIndex((item) => item.current),
        ),
  );
  const selection = useRef(selected);
  const select = (index: number) => {
    selection.current = index;
    setSelected(index);
  };
  const shown = useMemo(() => matchingItems(spec.items, query), [spec.items, query]);
  const index = Math.max(0, Math.min(selected, shown.length - 1));
  const height = Math.max(1, Math.min(ROWS, rows));
  const top = Math.max(0, Math.min(index - Math.floor(height / 2), shown.length - height));
  const visible = shown.slice(top, top + height);
  const pick = (item: PickItem) => {
    onClose();
    spec.onPick(item.value);
  };
  // Consecutive input events can arrive before React draws their new state.
  const current = () => {
    const matches = matchingItems(spec.items, input.current?.value ?? query);
    return { matches, index: Math.max(0, Math.min(selection.current, matches.length - 1)) };
  };
  const move = (distance: number) => {
    const { matches, index } = current();
    select(Math.max(0, Math.min(matches.length - 1, index + distance)));
  };

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      onClose();
      spec.onCancel?.();
    } else if (key.name === "up") {
      key.preventDefault();
      move(-1);
    } else if (key.name === "down") {
      key.preventDefault();
      move(1);
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      move(key.name === "pageup" ? -height : height);
    }
  });

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      // An empty side list keeps a coloured OpenTUI box explicitly borderless.
      border={compact ? [] : true}
      borderColor={theme.user}
      backgroundColor={theme.bg}
      paddingLeft={1}
      paddingRight={1}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        event.stopPropagation();
        move(direction === "up" ? -1 : 1);
      }}
    >
      <text selectable={false} fg={theme.user} truncate wrapMode="none">
        {spec.title}
      </text>
      <box flexDirection="row">
        <text selectable={false} fg={theme.dim}>
          filter{" "}
        </text>
        <input
          ref={input}
          focused
          flexGrow={1}
          value={spec.query ?? ""}
          placeholder="type to narrow"
          onInput={(value: string) => {
            setQuery(value);
            select(0);
          }}
          onSubmit={() => {
            const { matches, index } = current();
            const item = matches[index];
            if (item) pick(item);
          }}
        />
      </box>
      {visible.length === 0 ? (
        <text selectable={false} fg={theme.dim}>
          nothing matches
        </text>
      ) : null}
      {visible.map((item, offset) => {
        const chosen = top + offset === index;
        return (
          <box
            key={item.value}
            flexDirection="row"
            height={1}
            backgroundColor={chosen ? palette.rule : undefined}
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
                pick(item);
              }
            }}
          >
            <text
              selectable={false}
              fg={chosen ? theme.assistant : theme.dim}
              width={2}
              flexShrink={0}
              wrapMode="none"
            >
              {chosen ? "▸ " : "  "}
            </text>
            <text
              selectable={false}
              fg={item.current ? palette.yellow : theme.assistant}
              flexGrow={1}
              minWidth={0}
              truncate
              wrapMode="none"
            >
              {item.label}
              {item.detail ? <Detail text={item.detail} icon={item.icon} /> : null}
            </text>
          </box>
        );
      })}
      <text selectable={false} fg={theme.dim} truncate wrapMode="none">
        {width < 50
          ? `enter pick · esc close · ${shown.length} of ${spec.items.length}`
          : `${shown.length} of ${spec.items.length} · ↑↓ move · enter pick · esc close`}
      </text>
    </box>
  );
}
