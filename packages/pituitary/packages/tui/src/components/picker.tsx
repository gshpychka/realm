import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ListAction, matches } from "../keymap.ts";
import { keyHint, useKeymap } from "../keymap-context.tsx";
import { ellipsize } from "../text-width.ts";
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
  /** Text the filter also matches that the row does not show, such as a renamed session's first prompt. */
  keywords?: string;
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
  /** The item the list starts on, by value; otherwise the current one. */
  selected?: string;
  /** What other keys do to the item the list is on, such as renaming it. */
  keys?: readonly PickerKey[];
}

/** A key that acts on the item the list is on, given its value and the filter as typed. */
export interface PickerKey {
  /** The action whose keys do it, as the operator's keybindings bind them. */
  action: ListAction;
  /** What the key does, for the list's hint. */
  label: string;
  run(value: string, query: string): void;
}

/** Rows the list shows before it scrolls, room permitting. */
const ROWS = 10;

function matchingItems(items: readonly PickItem[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      const haystack = `${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase();
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
  const bindings = useKeymap();
  const input = useRef<InputRenderable>(null);
  const [query, setQuery] = useState(spec.query ?? "");
  const [selected, setSelected] = useState(() => {
    const start = matchingItems(spec.items, spec.query ?? "").findIndex((item) =>
      spec.selected === undefined ? !spec.query && item.current : item.value === spec.selected,
    );
    return Math.max(0, start);
  });
  const selection = useRef(selected);
  const select = (index: number) => {
    selection.current = index;
    setSelected(index);
  };
  // A list that comes again, as after renaming one of its items, goes to the item it names.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new list moves the selection
  useEffect(() => {
    if (spec.selected === undefined) return;
    const at = matchingItems(spec.items, input.current?.value ?? query).findIndex(
      (item) => item.value === spec.selected,
    );
    if (at !== -1) select(at);
  }, [spec]);
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
    } else {
      const bound = spec.keys?.find((each) => bindings[each.action].some((binding) => matches(key, binding)));
      if (!bound) return;
      key.preventDefault();
      const { matches: items, index } = current();
      const item = items[index];
      if (item) bound.run(item.value, input.current?.value ?? query);
    }
  });
  const keyHints =
    spec.keys?.flatMap((each) => {
      const hint = keyHint(bindings, each.action);
      return hint ? [`${hint} ${each.label}`] : [];
    }) ?? [];
  // The cells inside the frame and its padding, and a row's after its selection mark.
  const inner = width - (compact ? 0 : 2) - 2;
  const cells = inner - 2;
  const count = `${shown.length} of ${spec.items.length}`;
  // The keys every list has go first when the list's own keys need the room.
  const hints = [count, "↑↓ move", "enter pick", ...keyHints, "esc close"].join(" · ");
  const hint =
    width < 50
      ? `enter pick · esc close · ${count}`
      : Bun.stringWidth(hints) <= inner
        ? hints
        : ellipsize([count, ...keyHints, "esc close"].join(" · "), inner);

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
            <Row item={item} cells={cells} />
          </box>
        );
      })}
      <text selectable={false} fg={theme.dim} truncate wrapMode="none">
        {hint}
      </text>
    </box>
  );
}

/**
 * One item: its label cut at the end to the room its detail leaves, and the detail at the right
 * edge, so details line up down the list. The detail takes at most half the row.
 */
function Row({ item, cells }: { item: PickItem; cells: number }) {
  const icon = item.icon ? Bun.stringWidth(item.icon.glyph) + 1 : 0;
  const detail = item.detail ? ellipsize(item.detail, Math.floor(cells / 2) - 1 - icon) : "";
  const room = cells - (detail ? Bun.stringWidth(detail) + 1 + icon : 0);
  return (
    <>
      <text
        selectable={false}
        fg={item.current ? palette.yellow : theme.assistant}
        flexGrow={1}
        minWidth={0}
        wrapMode="none"
      >
        {ellipsize(item.label, room)}
      </text>
      {detail ? (
        <text selectable={false} flexShrink={0} wrapMode="none">
          <Detail text={detail} icon={item.icon} />
        </text>
      ) : null}
    </>
  );
}
