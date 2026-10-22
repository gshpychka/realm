import { useKeyboard } from "@opentui/react";
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
}: {
  spec: ChecklistSpec;
  onClose(): void;
  rows?: number;
}) {
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
  const index = Math.min(selected, Math.max(0, shown.length - 1));
  const height = Math.max(2, Math.min(ROWS, rows));
  const top = Math.max(0, Math.min(index - Math.floor(height / 2), shown.length - height));
  const visible = shown.slice(top, top + height);
  const current = shown[index];

  const change = (next: Checked) => {
    setChecked(next);
    setDirty(true);
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
      setSelected(Math.max(0, Math.min(shown.length - 1, index + delta)));
    } else if (key.name === "up") {
      key.preventDefault();
      setSelected(index === 0 ? shown.length - 1 : index - 1);
    } else if (key.name === "down") {
      key.preventDefault();
      setSelected(index >= shown.length - 1 ? 0 : index + 1);
    } else if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      setSelected(
        Math.max(0, Math.min(shown.length - 1, index + (key.name === "pageup" ? -height : height))),
      );
    } else if (key.name === "return") {
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
      border
      borderColor={theme.user}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.user}>
        {spec.title}
        {spec.note ? <span fg={theme.dim}> · {spec.note}</span> : null}
      </text>
      <box flexDirection="row">
        <text fg={theme.dim}>filter </text>
        <input
          focused
          flexGrow={1}
          placeholder="type to narrow"
          onInput={(value: string) => setQuery(value)}
        />
      </box>
      {visible.length === 0 ? <text fg={theme.dim}>nothing matches</text> : null}
      {visible.map((value, offset) => {
        const chosen = top + offset === index;
        const item = byValue.get(value);
        const on = isChecked(checked, value);
        return (
          <box key={value} flexDirection="row" backgroundColor={chosen ? palette.rule : undefined}>
            <text fg={chosen ? theme.assistant : theme.dim}>{chosen ? "▸ " : "  "}</text>
            <text fg={on && item ? palette.yellow : theme.dim}>{on ? "✓ " : "· "}</text>
            <text fg={item ? theme.assistant : theme.dim} truncate>
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
      <text fg={theme.dim}>
        {count}
        {dirty ? <span fg={palette.yellow}> · unsaved</span> : null} · enter check · ctrl+s save · esc close
      </text>
      <text fg={theme.dim}>
        {[
          "ctrl+a all",
          "ctrl+x none",
          ...(spec.groupName ? [`ctrl+p ${spec.groupName}`] : []),
          "alt+↑↓ reorder",
        ].join(" · ")}
      </text>
    </box>
  );
}
