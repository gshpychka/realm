import type { BoxRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { BashEntry, Entry, NoticeEntry } from "@pituitary/rpc";
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { explain } from "../errors.ts";
import { glyphs } from "../glyphs.ts";
import { counted } from "../plural.ts";
import { palette, theme } from "../theme.ts";
import { type Item, type Reply, transcriptOf, type Work } from "../transcript.ts";
import { turnLine } from "../working.ts";
import { Markdown } from "./markdown.tsx";
import { boxId, scrollWork, WorkBox } from "./work.tsx";

const NOTICE = {
  info: { mark: glyphs.info, colour: theme.dim },
  warning: { mark: glyphs.warning, colour: theme.tool },
  error: { mark: glyphs.error, colour: theme.error },
} as const;

/** Each line of an entry's body starts beyond its mark, including wrapped lines. */
function Marked({ mark, colour, children }: { mark: string; colour: string; children: ReactNode }) {
  const [width, setWidth] = useState<number>();
  // An integer width keeps OpenTUI's markdown measurement and drawing at the same
  // wrap boundary; an intrinsic flex width can differ by one column after wrapping.
  const measure = useCallback(function (this: BoxRenderable) {
    setWidth(Math.max(1, Math.floor(this.width) - 2));
  }, []);
  return (
    <box flexDirection="row" flexShrink={0} onSizeChange={measure}>
      <text fg={colour} width={2} flexShrink={0}>
        {mark}
      </text>
      <box flexDirection="column" width={width} flexGrow={width === undefined ? 1 : 0} flexShrink={0}>
        {children}
      </box>
    </box>
  );
}

/** Lines of a command shown collapsed, its latest ones, and expanded, before the rest is cut. */
const BASH_LINES = 5;
const BASH_EXPANDED = 400;

export interface Display {
  /** Tool output, summaries, and long commands shown whole, as ctrl+o asks. */
  expanded: boolean;
  /** Thinking shown as text; a one-line marker otherwise, as ctrl+t asks. */
  thinking: boolean;
  /** The keys that reach the interrupt from where the draft stands, such as `esc esc`. */
  escapes: string;
}

/** An entry the conversation draws as it is, which is any but the model's replies. */
type Plain = Exclude<Item, Work | Reply>;

const EntryView = memo(function EntryView({ entry, display }: { entry: Plain; display: Display }) {
  switch (entry.kind) {
    case "user":
      return (
        <box
          flexDirection="row"
          flexShrink={0}
          marginTop={1}
          backgroundColor={palette.surface}
          paddingRight={1}
        >
          <text fg={theme.user} flexShrink={0}>
            ▌{" "}
          </text>
          <text fg={theme.assistant} selectable>
            {entry.text}
          </text>
        </box>
      );
    case "bash":
      return <Bash entry={entry} expanded={display.expanded} escapes={display.escapes} />;
    case "custom":
      return (
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <Marked mark="●" colour={theme.dim}>
            <text fg={theme.dim}>[{entry.customType}]</text>
            <Markdown content={entry.text} />
          </Marked>
        </box>
      );
    case "summary":
      return (
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <Marked mark={glyphs.summary} colour={theme.dim}>
            <text fg={theme.dim}>
              [{entry.of}]
              {entry.tokensBefore === undefined
                ? ""
                : ` compacted from ${glyphs.tokens} ${entry.tokensBefore.toLocaleString("en")} tokens`}
              {display.expanded ? "" : " · ctrl+o"}
            </text>
            {display.expanded ? <Markdown content={entry.text} fg={theme.thinking} /> : null}
          </Marked>
        </box>
      );
    case "turn":
      return (
        <box flexShrink={0} marginTop={1}>
          <text fg={theme.dim}>{turnLine(entry)}</text>
        </box>
      );
    case "notice":
      return <Notice entry={entry} expanded={display.expanded} />;
  }
});

/**
 * A notice. A warning or error shows as one line saying what went wrong and what deals with
 * it; when that rewords the error, ctrl+o shows the words it came in.
 */
function Notice({ entry, expanded }: { entry: NoticeEntry; expanded: boolean }) {
  const { mark, colour } = NOTICE[entry.level];
  const { text, remedy, original } = entry.level === "info" ? { text: entry.text } : explain(entry.text);
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Marked mark={mark} colour={colour}>
        <text fg={colour}>
          {text}
          {remedy ? (
            <>
              <span fg={theme.dim}> · </span>
              <span fg={theme.tool}>{remedy.command}</span>
              <span fg={theme.dim}> {remedy.does}</span>
            </>
          ) : null}
          {original && !expanded ? <span fg={theme.dim}> · ctrl+o</span> : null}
        </text>
        {original && expanded ? (
          <text fg={theme.dim} selectable>
            {original}
          </text>
        ) : null}
      </Marked>
    </box>
  );
}

/** What the model says once its work is done, and why it stopped short when it did. */
const ReplyView = memo(
  function ReplyView({ reply }: { reply: Reply }) {
    return (
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        {reply.text ? (
          <Marked mark="●" colour={theme.assistant}>
            <Markdown content={reply.text} streaming={reply.streaming} />
          </Marked>
        ) : null}
        {reply.note ? (
          <Marked mark={glyphs.warning} colour={theme.tool}>
            <text fg={theme.tool}>{reply.note}</text>
          </Marked>
        ) : null}
      </box>
    );
  },
  (before, after) =>
    before.reply.text === after.reply.text &&
    before.reply.streaming === after.reply.streaming &&
    before.reply.note === after.reply.note,
);

function Bash({ entry, expanded, escapes }: { entry: BashEntry; expanded: boolean; escapes: string }) {
  const all = entry.output.replace(/\n+$/, "").split("\n");
  const kept = all.length === 1 && all[0] === "" ? [] : all;
  const lines = kept.slice(-(expanded ? BASH_EXPANDED : BASH_LINES));
  const hidden = kept.length - lines.length;
  const failed = entry.exitCode !== null && entry.exitCode !== 0;
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Marked mark="$" colour={theme.tool}>
        <text selectable>
          <span fg={theme.tool}>{entry.command}</span>
          {entry.excluded ? <span fg={theme.dim}> · not in context</span> : null}
          {entry.running ? <span fg={theme.dim}> · running · {escapes} cancels</span> : null}
          {entry.cancelled ? <span fg={theme.dim}> · cancelled</span> : null}
          {failed ? <span fg={theme.error}> · exit {entry.exitCode}</span> : null}
          {entry.truncated ? <span fg={theme.dim}> · output cut</span> : null}
        </text>
        {hidden > 0 ? (
          <text fg={theme.dim}>
            … {counted(hidden, "earlier line")}
            {expanded ? "" : " · ctrl+o"}
          </text>
        ) : null}
        {lines.length > 0 ? (
          <text fg={theme.dim} selectable>
            {lines.join("\n")}
          </text>
        ) : null}
      </Marked>
    </box>
  );
}

const KEYS = [
  ["enter", "send"],
  ["shift+enter  ctrl+j", "new line"],
  ["!cmd  !!cmd", "run a command, kept in or out of context"],
  ["alt+enter", "queue a follow-up while pi works"],
  ["esc", "interrupt and take back queued messages"],
  ["/  @", "commands, and files to mention"],
  ["ctrl+o", "open every box of work at full length"],
  ["ctrl+f", "step through the boxes: ↑↓ enter j k"],
  ["ctrl+t", "show or hide thinking"],
  ["ctrl+l  ctrl+p", "pick a model, or take the next one"],
  ["ctrl+g", "edit in $VISUAL"],
  ["pgup  pgdn", "scroll"],
  ["ctrl+c twice  ctrl+d", "quit"],
] as const;

/** The empty conversation: where to start, and the keys. */
export function Welcome({ escapes }: { escapes: string }) {
  const rows = KEYS.map(([keys, does]) =>
    keys === "esc" && escapes !== "esc" ? [escapes, `leave insert mode, then ${does}`] : [keys, does],
  );
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.dim} flexShrink={0}>
        Ask pi something to get started.
      </text>
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        {rows.map(([keys, does]) => (
          <box key={keys} flexDirection="row" flexShrink={0} height={1}>
            <text fg={theme.tool} width={22} flexShrink={0} truncate wrapMode="none">
              {keys}
            </text>
            <text fg={theme.dim} truncate wrapMode="none">
              {does}
            </text>
          </box>
        ))}
      </box>
    </box>
  );
}

export interface ConversationProps {
  entries: Entry[];
  /** A run is in progress. */
  running: boolean;
  display: Display;
  /** How many of the latest entries are drawn; the earlier ones wait for the operator to scroll back. */
  window: number;
  /** The keyboard steps through the boxes of work, the latest picked first. */
  browsing: boolean;
  /** Hands the keyboard back, as esc asks while browsing. */
  onLeave(): void;
  ref: RefObject<ScrollBoxRenderable | null>;
}

const SCROLLBAR = { trackOptions: { foregroundColor: palette.rule, backgroundColor: theme.bg } };

/** Rows an open box shows before it scrolls: a third of the terminal, and never too few to read. */
const boxRows = (height: number) => Math.max(6, Math.floor(height / 3));

/** What a key does while the keyboard walks the boxes. */
type Walk = { kind: "leave" } | { kind: "toggle" } | { kind: "pick" | "scroll"; by: number };

const WALK = new Map<string, Walk>([
  ["escape", { kind: "leave" }],
  ["up", { kind: "pick", by: -1 }],
  ["down", { kind: "pick", by: 1 }],
  ["return", { kind: "toggle" }],
  ["space", { kind: "toggle" }],
  ["k", { kind: "scroll", by: -1 }],
  ["j", { kind: "scroll", by: 1 }],
]);

function stepOf(key: KeyEvent): Walk | null {
  if (key.ctrl && key.name === "c") return { kind: "leave" };
  return key.ctrl || key.meta ? null : (WALK.get(key.name) ?? null);
}

/** Boxes the operator opened or closed; ctrl+o setting every box one way clears them. */
interface Pins {
  /** Whether every box was open at full length when these were set. */
  whole: boolean;
  open: ReadonlyMap<string, boolean>;
}

const UNPINNED: ReadonlyMap<string, boolean> = new Map();

/**
 * Which boxes are open: each while the model works in it, every one when `whole`, and any
 * the operator opened or closed, until `whole` changes.
 */
function useOpenBoxes(whole: boolean) {
  const [pins, setPins] = useState<Pins>({ whole, open: UNPINNED });
  const pinned = pins.whole === whole ? pins.open : UNPINNED;
  const isOpen = (work: Work) => pinned.get(work.id) ?? (whole || work.live);
  const toggle = useCallback(
    (id: string, open: boolean) =>
      setPins((current) => ({
        whole,
        open: new Map(current.whole === whole ? current.open : UNPINNED).set(id, open),
      })),
    [whole],
  );
  return { isOpen, toggle };
}

interface Walking {
  browsing: boolean;
  boxes: readonly Work[];
  scroll: RefObject<ScrollBoxRenderable | null>;
  isOpen(work: Work): boolean;
  toggle(id: string, open: boolean): void;
  onLeave(): void;
}

/** The box `chosen` names among `boxes`, or the latest while it names none of them. */
function pickOf(boxes: readonly Work[], chosen: string | null): Work | null {
  return boxes.find((work) => work.id === chosen) ?? boxes.at(-1) ?? null;
}

/** The box `by` steps away from `work` among `boxes`, stopping at either end. */
function neighbour(boxes: readonly Work[], work: Work, by: number): Work {
  return boxes[Math.max(0, Math.min(boxes.length - 1, boxes.indexOf(work) + by))] ?? work;
}

/** Scrolls `work` by `by` rows while it has rows to give, and the conversation after, as the wheel does. */
function scrollThrough(view: ScrollBoxRenderable | null, work: Work, by: number): void {
  if (view && !scrollWork(view, work, by)) view.scrollBy(by);
}

/**
 * The keyboard walking the boxes while `browsing`, from the latest: the box it has picked,
 * kept in view as the pick moves and as the box changes size.
 */
function useWalk({ browsing, boxes, scroll, isOpen, toggle, onLeave }: Walking) {
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (!browsing) setChosen(null);
  }, [browsing]);
  const selected = browsing ? pickOf(boxes, chosen) : null;

  const reveal = useCallback((id: string) => scroll.current?.scrollChildIntoView(boxId({ id })), [scroll]);
  const selectedId = selected?.id ?? null;
  const picked = useRef(selectedId);
  picked.current = selectedId;
  // Layout settles only after the commit, so a box that changes size says so once it has.
  const resized = useCallback(
    (id: string) => {
      if (id === picked.current) reveal(id);
    },
    [reveal],
  );
  useEffect(() => {
    if (selectedId) reveal(selectedId);
  }, [selectedId, reveal]);

  useKeyboard((key) => {
    const step = browsing ? stepOf(key) : null;
    if (!step) return;
    key.preventDefault();
    if (step.kind === "leave") onLeave();
    else if (step.kind === "pick" && selected) setChosen(neighbour(boxes, selected, step.by).id);
    else if (step.kind === "toggle" && selected) toggle(selected.id, !isOpen(selected));
    else if (step.kind === "scroll" && selected) scrollThrough(scroll.current, selected, step.by);
  });

  return { selected, resized };
}

/**
 * The conversation, newest at the bottom. Only the latest `window` entries are drawn,
 * which keeps the number of drawn elements bounded however long the session runs.
 */
export function Conversation({
  entries,
  running,
  display,
  window,
  browsing,
  onLeave,
  ref,
}: ConversationProps) {
  const { height } = useTerminalDimensions();
  const earlier = Math.max(0, entries.length - window);
  const items = useMemo(() => transcriptOf(entries.slice(earlier), running), [entries, earlier, running]);
  const boxes = items.filter((item): item is Work => item.kind === "work");
  const whole = display.expanded;
  const { isOpen, toggle } = useOpenBoxes(whole);
  const { selected, resized } = useWalk({ browsing, boxes, scroll: ref, isOpen, toggle, onLeave });

  if (entries.length === 0) return <Welcome escapes={display.escapes} />;
  const rows = boxRows(height);
  return (
    <scrollbox
      ref={ref}
      flexGrow={1}
      flexShrink={1}
      stickyScroll
      stickyStart="bottom"
      scrollX={false}
      focusable={false}
      paddingLeft={1}
      paddingRight={1}
      verticalScrollbarOptions={SCROLLBAR}
    >
      {earlier > 0 ? (
        <text fg={theme.dim} flexShrink={0}>
          … {earlier} earlier entr{earlier === 1 ? "y" : "ies"} · pgup at the top shows more
        </text>
      ) : null}
      {items.map((item) => {
        switch (item.kind) {
          case "work":
            return (
              <WorkBox
                key={item.id}
                work={item}
                open={isOpen(item)}
                whole={whole}
                thinking={display.thinking}
                selected={item === selected}
                rows={rows}
                onToggle={toggle}
                onResized={resized}
              />
            );
          case "reply":
            return <ReplyView key={item.id} reply={item} />;
          default:
            return <EntryView key={item.id} entry={item} display={display} />;
        }
      })}
    </scrollbox>
  );
}
