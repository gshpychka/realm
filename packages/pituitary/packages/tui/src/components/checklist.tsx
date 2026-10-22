import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import { type Checked, checkAll, clearAll, isChecked, ordered, reorder, toggle } from "../checklist.ts";
import { palette, theme } from "../theme.ts";
import { Detail, type DetailIcon } from "./detail.tsx";

export interface CheckItem {
  label: string;
  detail?: string;
  /** Leads the detail. */
  icon?: DetailIcon;
  value: string;
  /** Items that check and clear together, such as one provider's models. */
  group?: string;
}

/** A set the operator checks from a list, in an order, and what saving it does. */
export interface ChecklistSpec {
  title: string;
  /** What the checked items are for, drawn under the title. */
  note?: string;
  items: readonly CheckItem[];
  /** What the items' groups are called, such as provider. */
  groupName?: string;
  /** What is checked at first; a checked value missing from `items` stays checked, drawn as unavailable. */
  checked: Checked;
  onSave(checked: Checked): void;
}

/** Rows the list shows before it scrolls, room permitting. */
const ROWS = 10;

/**
 * A filterable list in the editor's place, with the keys of pi's own scoped-models list: enter
 * checks, ctrl+a checks all, ctrl+x clears, ctrl+p checks a group, alt+↑↓ reorders, ctrl+s saves.
 * ctrl+a and ctrl+x act on what the filter shows while it narrows the list.
 */
export function Checklist({
  spec,
  onClose,
  rows = ROWS,
  compact = false,
}: {
  spec: ChecklistSpec;
  onClose(): void;
  rows?: number;
  compact?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const [checked, setChecked] = useState<Checked>(spec.checked);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const byValue = useMemo(() => new Map(spec.items.map((item) => [item.value, item])), [spec.items]);
  const all = useMemo(() => spec.items.map((item) => item.value), [spec.items]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return ordered(checked, all).filter((value) => {
      const item = byValue.get(value);
      const haystack = `${item?.label ?? value} ${item?.detail ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [checked, all, byValue, query]);
  const index = Math.max(0, Math.min(selected, shown.length - 1));
  const height = Math.max(1, Math.min(ROWS, rows));
  const top = Math.max(0, Math.min(index - Math.floor(height / 2), shown.length - height));
  const visible = shown.slice(top, top + height);
  const current = shown[index];

  const change = (next: Checked, focus = current) => {
    setChecked(next);
    setDirty(true);
    // Checking changes the list's order; keep the same item under the cursor.
    const visible = new Set(shown);
    setSelected(
      Math.max(
        0,
        ordered(next, all)
          .filter((value) => visible.has(value))
          .indexOf(focus ?? ""),
      ),
    );
  };

  useKeyboard((key) => {
    const targets = query ? shown : undefined;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      onClose();
    } else if (key.meta && (key.name === "up" || key.name === "down")) {
      key.preventDefault();
      if (!current || !isChecked(checked, current) || checked === null) return;
      const delta = key.name === "up" ? -1 : 1;
      const next = reorder(checked, current, delta);
      if (next === checked) return;
      change(next);
    } else if (key.name === "up") {
      key.preventDefault();
      setSelected(Math.max(0, index === 0 ? shown.length - 1 : index - 1));
    } else if (key.name === "down") {
      key.preventDefault();
      setSelected(index >= shown.length - 1 ? 0 : index + 1);
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      setSelected(
        Math.max(0, Math.min(shown.length - 1, index + (key.name === "pageup" ? -height : height))),
      );
    } else if (key.name === "return" || key.name === "kpenter") {
      key.preventDefault();
      if (current) change(toggle(checked, all, current));
    } else if (key.ctrl && key.name === "a") {
      key.preventDefault();
      change(checkAll(checked, all, targets));
    } else if (key.ctrl && key.name === "x") {
      key.preventDefault();
      change(clearAll(checked, all, targets));
    } else if (key.ctrl && key.name === "p") {
      key.preventDefault();
      const group = current ? byValue.get(current)?.group : undefined;
      if (group === undefined) return;
      const members = spec.items.filter((item) => item.group === group).map((item) => item.value);
      const whole = members.every((value) => isChecked(checked, value));
      change(whole ? clearAll(checked, all, members) : checkAll(checked, all, members));
    } else if (key.ctrl && key.name === "s") {
      key.preventDefault();
      onClose();
      spec.onSave(checked);
    }
  });

  const unavailable = checked?.filter((value) => !byValue.has(value)).length ?? 0;
  const count =
    checked === null
      ? "all checked"
      : `${checked.length - unavailable} of ${all.length} checked${unavailable ? ` · ${unavailable} unavailable` : ""}`;

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
        {spec.note ? <span fg={theme.dim}> · {spec.note}</span> : null}
      </text>
      <box flexDirection="row">
        <text fg={theme.dim}>filter </text>
        <input
          focused
          flexGrow={1}
          placeholder="type to narrow"
          onInput={(value: string) => {
            setQuery(value);
            setSelected(0);
          }}
        />
      </box>
      {visible.length === 0 ? <text fg={theme.dim}>nothing matches</text> : null}
      {visible.map((value, offset) => {
        const chosen = top + offset === index;
        const item = byValue.get(value);
        const on = isChecked(checked, value);
        return (
          <box
            key={value}
            flexDirection="row"
            height={1}
            backgroundColor={chosen ? palette.rule : undefined}
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
                change(toggle(checked, all, value), value);
              }
            }}
          >
            <text fg={chosen ? theme.assistant : theme.dim} width={2} flexShrink={0} wrapMode="none">
              {chosen ? "▸ " : "  "}
            </text>
            <text fg={on && item ? palette.yellow : theme.dim} width={2} flexShrink={0} wrapMode="none">
              {on ? "✓ " : "· "}
            </text>
            <text fg={item ? theme.assistant : theme.dim} flexGrow={1} minWidth={0} truncate wrapMode="none">
              {item?.label ?? value}
              {item ? (
                <Detail text={item.detail ?? ""} icon={item.icon} />
              ) : (
                <span fg={theme.dim}> unavailable</span>
              )}
            </text>
          </box>
        );
      })}
      <text fg={theme.dim} truncate wrapMode="none">
        {width < 64 ? `ctrl+s save · ${count}` : count}
        {dirty && width >= 64 ? <span fg={palette.yellow}> · unsaved</span> : null}
        {width < 64 ? "" : " · enter check · ctrl+s save · esc close"}
      </text>
      <text fg={theme.dim} truncate wrapMode="none">
        {width < 64 ? (
          <>enter check · esc close{dirty ? <span fg={palette.yellow}> · unsaved</span> : null}</>
        ) : (
          [
            "ctrl+a all",
            "ctrl+x none",
            ...(spec.groupName ? [`ctrl+p ${spec.groupName}`] : []),
            "alt+↑↓ reorder",
          ].join(" · ")
        )}
      </text>
    </box>
  );
}
