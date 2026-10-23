import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
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
  const [query, setQuery] = useState(spec.query ?? "");
  const [selected, setSelected] = useState(() =>
    spec.query
      ? 0
      : Math.max(
          0,
          spec.items.findIndex((item) => item.current),
        ),
  );
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return spec.items
      .filter((item) => {
        const haystack = `${item.label} ${item.detail ?? ""}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort(
        (a, b) =>
          Number(words.every((word) => b.label.toLowerCase().includes(word))) -
          Number(words.every((word) => a.label.toLowerCase().includes(word))),
      );
  }, [spec.items, query]);
  const index = Math.max(0, Math.min(selected, shown.length - 1));
  const height = Math.max(1, Math.min(ROWS, rows));
  const top = Math.max(0, Math.min(index - Math.floor(height / 2), shown.length - height));
  const visible = shown.slice(top, top + height);
  const pick = (item: PickItem) => {
    onClose();
    spec.onPick(item.value);
  };

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      onClose();
      spec.onCancel?.();
    } else if (key.name === "up") {
      key.preventDefault();
      setSelected(Math.max(0, index - 1));
    } else if (key.name === "down") {
      key.preventDefault();
      setSelected(Math.max(0, Math.min(shown.length - 1, index + 1)));
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      setSelected(
        Math.max(0, Math.min(shown.length - 1, index + (key.name === "pageup" ? -height : height))),
      );
    } else if (key.name === "return" || key.name === "kpenter") {
      key.preventDefault();
      const item = shown[index];
      if (!item) return;
      pick(item);
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
        setSelected(Math.max(0, Math.min(shown.length - 1, index + (direction === "up" ? -1 : 1))));
      }}
    >
      <text fg={theme.user} truncate wrapMode="none">
        {spec.title}
      </text>
      <box flexDirection="row">
        <text fg={theme.dim}>filter </text>
        <input
          focused
          flexGrow={1}
          value={spec.query ?? ""}
          placeholder="type to narrow"
          onInput={(value: string) => {
            setQuery(value);
            setSelected(0);
          }}
        />
      </box>
      {visible.length === 0 ? <text fg={theme.dim}>nothing matches</text> : null}
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
            <text fg={chosen ? theme.assistant : theme.dim} width={2} flexShrink={0} wrapMode="none">
              {chosen ? "▸ " : "  "}
            </text>
            <text
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
      <text fg={theme.dim} truncate wrapMode="none">
        {width < 50
          ? `enter pick · esc close · ${shown.length} of ${spec.items.length}`
          : `${shown.length} of ${spec.items.length} · ↑↓ move · enter pick · esc close`}
      </text>
    </box>
  );
}
