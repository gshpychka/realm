import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CURRENT, type Hint, hintLine, MOVE, PICK, SELECTED, UNSELECTED } from "../hints.ts";
import { type ListAction, matches } from "../keymap.ts";
import { keyHint, useKeymap } from "../keymap-context.tsx";
import { ellipsize, ellipsizeBefore } from "../text-width.ts";
import { palette, theme } from "../theme.ts";
import { Detail, type DetailIcon } from "./detail.tsx";

/** A word that follows an item's label after a dim dot, such as whose a skill is. */
export interface Tag {
  text: string;
  colour: string;
}

export interface PickItem {
  label: string;
  /**
   * Drawn dim before the label and its mark, such as a tree's lines. It joins a row to the rows
   * around it, so a filtered list, which leaves some of those out, draws none; nor does the
   * filter read it.
   */
  lead?: string;
  /** Leads the label, such as the kind of entry a tree's row stands for. */
  mark?: DetailIcon;
  /** Set apart from the rows that matter more, such as a tree's other branches: its label and tag are dim. */
  dim?: boolean;
  detail?: string;
  /** Leads the detail. */
  icon?: DetailIcon;
  /** Follows the label, kept whole while the label is cut to make room for it. */
  tag?: Tag;
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
  /**
   * The operator picked the highlighted item, `value`. A list of `multiple` picks every item
   * marked, `picked`, in the list's order, or the highlighted one when none is.
   */
  onPick(value: string, picked: readonly string[]): void;
  /** Tab, or a click, marks items, and enter picks those marked. */
  multiple?: boolean;
  /** The items a list of `multiple` starts with marked, by value. */
  marked?: readonly string[];
  /** Runs when the operator closes the list without picking. */
  onCancel?(): void;
  /** What the filter starts with, as `/model sonnet` narrows the list to match. */
  query?: string;
  /** The item the list starts on, by value; otherwise the current one. */
  selected?: string;
  /** What other keys do to the item the list is on, such as renaming it. */
  keys?: readonly PickerKey[];
  /** A list worth more rows than most, such as a session's tree: up to half the terminal, room permitting. */
  tall?: boolean;
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
/** How a list of several marks each row: marked, or not. */
const MARKS = { on: "◉ ", off: "○ " } as const;

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
  const { width, height: terminal } = useTerminalDimensions();
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
  // Keys that arrive together, faster than React draws, each mark the list as the one before left it.
  const marking = useRef<ReadonlySet<string>>(new Set(spec.multiple ? spec.marked : []));
  const [marked, setMarked] = useState(marking.current);
  const mark = (value: string) => {
    const next = new Set(marking.current);
    if (!next.delete(value)) next.add(value);
    marking.current = next;
    setMarked(next);
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
  const most = spec.tall ? Math.max(ROWS, Math.floor(terminal / 2)) : ROWS;
  const height = Math.max(1, Math.min(most, rows));
  const top = Math.max(0, Math.min(index - Math.floor(height / 2), shown.length - height));
  const visible = shown.slice(top, top + height);
  /** Picks `item`, the highlighted one, or in a list of several those marked, with or without one highlighted. */
  const pick = (item: PickItem | undefined) => {
    const picked = spec.items.filter((each) => marking.current.has(each.value)).map((each) => each.value);
    const value = item?.value ?? picked[0];
    if (value === undefined) return;
    onClose();
    spec.onPick(value, picked.length ? picked : [value]);
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
    } else if (spec.multiple && key.name === "tab" && !key.shift && !key.ctrl && !key.meta) {
      // Tab marks, as in fzf, leaving space to the filter's words.
      key.preventDefault();
      const { matches: items, index } = current();
      const item = items[index];
      if (item) mark(item.value);
    } else {
      const bound = spec.keys?.find((each) => bindings[each.action].some((binding) => matches(key, binding)));
      if (!bound) return;
      key.preventDefault();
      const { matches: items, index } = current();
      const item = items[index];
      if (item) bound.run(item.value, input.current?.value ?? query);
    }
  });
  // The list's own keys, as the operator binds them; an unbound one has no hint.
  const keyHints =
    spec.keys?.map((each): Hint | null => {
      const keys = keyHint(bindings, each.action);
      return keys ? [keys, each.label] : null;
    }) ?? [];
  // The cells inside the frame and its padding, and a row's after its selection mark and, in a
  // list of several, its mark.
  const inner = width - (compact ? 2 : 4);
  const cells = inner - Bun.stringWidth(SELECTED) - (spec.multiple ? Bun.stringWidth(MARKS.off) : 0);
  const picks: Hint = spec.multiple && marked.size > 0 ? ["enter", `pick ${marked.size}`] : PICK;
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
      <text selectable={false} fg={theme.user} wrapMode="none">
        {ellipsize(spec.title, inner)}
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
          placeholderColor={theme.dim}
          textColor={theme.assistant}
          focusedTextColor={theme.assistant}
          onInput={(value: string) => {
            setQuery(value);
            select(0);
          }}
          onSubmit={() => {
            const { matches, index } = current();
            pick(matches[index]);
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
              if (event.button !== 0) return;
              event.preventDefault();
              // In a list of several a click marks the row, as tab does; enter then picks.
              if (spec.multiple) {
                select(top + offset);
                mark(item.value);
              } else pick(item);
            }}
          >
            <text
              selectable={false}
              fg={chosen ? theme.assistant : theme.dim}
              width={2}
              flexShrink={0}
              wrapMode="none"
            >
              {chosen ? SELECTED : UNSELECTED}
            </text>
            {spec.multiple ? (
              <text
                selectable={false}
                fg={marked.has(item.value) ? theme.cursor : theme.dim}
                flexShrink={0}
                wrapMode="none"
              >
                {marked.has(item.value) ? MARKS.on : MARKS.off}
              </text>
            ) : null}
            <Row item={item} cells={cells} filtered={query.trim() !== ""} chosen={chosen} />
          </box>
        );
      })}
      <text selectable={false} fg={theme.dim} wrapMode="none">
        {hintLine(
          [MOVE, ...(spec.multiple ? [["tab", "mark"] as const] : []), picks, ...keyHints, ["esc", "close"]],
          `${shown.length} of ${spec.items.length}`,
          inner,
        )}
      </text>
    </box>
  );
}

/** What comes between a label and its tag. */
const TAG_DOT = " · ";
/** Cells a label keeps before its tag gives way to it. */
const TAG_LEAST = 8;

/**
 * One item: its label cut at the end to the room its detail leaves, and the detail at the right
 * edge, so details line up down the list. The label keeps what it needs, with its tag and mark,
 * up to half the row, and the detail takes the rest: a short label, such as a task's role,
 * leaves its room to a long detail, such as the task's objective. A tag stays whole after the
 * label while the label keeps a few cells. The item in effect now says so after its label,
 * cutting the label for the mark unless that would leave the label narrower than the mark; a
 * label without its mark leaves the mark's room to the detail too. A lead and a label's mark
 * come first and keep their cells; a lead deeper than half the row keeps its end, which joins
 * the label, and a filtered list draws no lead.
 */
function Row({
  item,
  cells: row,
  filtered,
  chosen,
}: {
  item: PickItem;
  cells: number;
  filtered: boolean;
  /** The row the list is on, whose label reads in full colour. */
  chosen: boolean;
}) {
  const deepest = Math.floor(row / 2);
  const lead =
    !item.lead || filtered
      ? undefined
      : item.lead.length > deepest
        ? item.lead.slice(item.lead.length - deepest)
        : item.lead;
  const cells =
    row - (lead ? Bun.stringWidth(lead) : 0) - (item.mark ? Bun.stringWidth(item.mark.glyph) + 1 : 0);
  const icon = item.icon ? Bun.stringWidth(item.icon.glyph) + 1 : 0;
  const mark = Bun.stringWidth(CURRENT);
  const tag = item.tag ? Bun.stringWidth(`${TAG_DOT}${item.tag.text}`) : 0;
  const fit = (after: number) => {
    const label = Math.min(Bun.stringWidth(item.label) + tag + after, Math.floor(cells / 2));
    const detail = item.detail ? ellipsize(item.detail, cells - label - 1 - icon) : "";
    return { detail, room: cells - (detail ? Bun.stringWidth(detail) + 1 + icon : 0) };
  };
  const marked = item.current ? fit(mark) : null;
  const current = marked !== null && marked.room >= 2 * mark;
  const { detail, room } = current ? marked : fit(0);
  const label = ellipsizeBefore(item.label, tag, current ? room - mark : room, TAG_LEAST);
  const aside = item.dim && !chosen;
  return (
    <>
      {lead || item.mark ? (
        <text selectable={false} flexShrink={0} wrapMode="none">
          {lead ? <span fg={theme.dim}>{lead}</span> : null}
          {item.mark ? <span fg={item.mark.colour ?? theme.dim}>{`${item.mark.glyph} `}</span> : null}
        </text>
      ) : null}
      <text
        selectable={false}
        fg={item.current ? palette.yellow : aside ? theme.dim : theme.assistant}
        flexGrow={1}
        minWidth={0}
        wrapMode="none"
      >
        {label.text}
        {item.tag && label.suffix ? (
          <>
            <span fg={theme.dim}>{TAG_DOT}</span>
            <span fg={aside ? theme.dim : item.tag.colour}>{item.tag.text}</span>
          </>
        ) : null}
        {current ? CURRENT : null}
      </text>
      {detail ? (
        <text selectable={false} flexShrink={0} wrapMode="none">
          <Detail text={detail} icon={item.icon} />
        </text>
      ) : null}
    </>
  );
}
