import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { Entry, NoticeEntry } from "@pituitary/session";
import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IMAGE_TOKEN } from "../attachments.ts";
import { explain } from "../errors.ts";
import { glyphs } from "../glyphs.ts";
import { IMAGE_CHIP } from "../image-chip.ts";
import type { Action } from "../keymap.ts";
import { keyHint, useKeyHint, useKeymap } from "../keymap-context.tsx";
import { ellipsize } from "../text-width.ts";
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
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={2}>
      <text selectable={false} position="absolute" left={0} top={0} fg={colour} width={2}>
        {mark}
      </text>
      {children}
    </box>
  );
}

export interface Display {
  /** Tool output, summaries, and long commands shown whole, as ctrl+o asks. */
  expanded: boolean;
  /** Thinking shown as text; a one-line marker otherwise, as ctrl+t asks. */
  thinking: boolean;
  /** The keys that reach the interrupt from where the draft stands, such as `esc esc`. */
  escapes: string;
  /** Commands the operator can run here, which an error's remedy may name. */
  commands: ReadonlySet<string>;
}

/** A message's text, with `[image N]` drawn as a chip for each of the `images` it carries. */
function withImageChips(text: string, images: number): ReactNode {
  if (images === 0) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(IMAGE_TOKEN)) {
    const n = Number(match[1]);
    if (n < 1 || n > images) continue;
    parts.push(
      text.slice(from, match.index),
      <span key={`${match.index}-start`} fg={theme.imageTint}>
        {IMAGE_CHIP.start}
      </span>,
      <span key={`${match.index}-label`} fg={theme.image} bg={theme.imageTint}>
        {`${IMAGE_CHIP.label}${n}`}
      </span>,
      <span key={`${match.index}-stop`} fg={theme.imageTint}>
        {IMAGE_CHIP.stop}
      </span>,
    );
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

/** An entry the conversation draws as it is, which is any but the model's replies. */
type Plain = Exclude<Item, Work | Reply>;

const EntryView = memo(function EntryView({ entry, display }: { entry: Plain; display: Display }) {
  const expand = useKeyHint("app.tools.expand");
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
          <text selectable={false} fg={theme.user} flexShrink={0}>
            ▌{" "}
          </text>
          <text fg={theme.assistant}>{withImageChips(entry.text, entry.images)}</text>
        </box>
      );
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
            <box flexDirection="row">
              <text fg={theme.dim}>
                [{entry.of}]
                {entry.tokensBefore === undefined
                  ? ""
                  : ` compacted from ${glyphs.tokens} ${entry.tokensBefore.toLocaleString("en")} tokens`}
              </text>
              {!display.expanded && expand ? (
                <text selectable={false} fg={theme.dim} flexShrink={0} wrapMode="none">
                  {` · ${expand}`}
                </text>
              ) : null}
            </box>
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
      return <Notice entry={entry} expanded={display.expanded} commands={display.commands} />;
  }
});

/**
 * A notice. A warning or error shows as one line saying what went wrong and what deals with
 * it; ctrl+o shows what else the error said, such as its stack or the response body.
 */
function Notice({
  entry,
  expanded,
  commands,
}: {
  entry: NoticeEntry;
  expanded: boolean;
  commands: ReadonlySet<string>;
}) {
  const expand = useKeyHint("app.tools.expand");
  const { mark, colour } = NOTICE[entry.level];
  const { text, remedy, detail } =
    entry.level === "info" ? { text: entry.text } : explain(entry.text, commands);
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Marked mark={mark} colour={colour}>
        {/* The key that shows the rest flows after the remedy, so a wrapped remedy stays whole. */}
        <text fg={colour}>
          {text}
          {remedy ? <span fg={theme.assistant}> · {remedy}</span> : null}
          {detail && !expanded && expand ? <span fg={theme.dim}> · {expand}</span> : null}
        </text>
        {detail && expanded ? <text fg={theme.dim}>{detail}</text> : null}
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

/** A key on the welcome screen, what it does, and the shorter words a narrow screen takes. */
type WelcomeRow = readonly [keys: string, does: string, short?: string];

const editorKeys = (local: boolean): readonly WelcomeRow[] => [
  ["enter", "send"],
  ["shift+enter  ctrl+j", "new line"],
  local ? ["/  @", "commands, and files to mention", "commands, files"] : ["/", "commands"],
  ["pgup  pgdn", "scroll"],
];

/** Cells between the key column and what the key does. */
const KEY_GAP = 2;
/** Cells the key column leaves for what the keys do, where it can. */
const DOES_LEAST = 16;

/**
 * The empty conversation: where to start, and the keys. When one row's words do not fit, every
 * row that has shorter words takes them, so the list reads alike.
 */
export function Welcome({
  escapes,
  agent,
  local = true,
  modelSelectable = local,
  providerUsage = false,
}: {
  escapes: string;
  /** What the operator calls the agent, such as `pi` or `the builder` for a Dura task's role. */
  agent: string;
  local?: boolean;
  modelSelectable?: boolean;
  /** The footer's card shows the provider's usage beside the session's cost. */
  providerUsage?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const bindings = useKeymap();
  const bound = (action: Action) => keyHint(bindings, action) ?? "";
  const interrupt = bound("app.interrupt");
  const rows = (
    [
      ...editorKeys(local),
      [bound("app.message.followUp"), `queue a follow-up while ${agent} works`, "queue a follow-up"],
      [
        interrupt ? escapes : "",
        interrupt === "esc" && escapes !== "esc"
          ? "leave insert mode, then interrupt"
          : "interrupt and take back queued messages",
        "interrupt",
      ],
      [bound("app.tools.expand"), "open every box of work at full length", "open every box"],
      [bound("app.tools.browse"), "step through boxes: ↑↓ enter j k", "step through boxes"],
      [bound("app.thinking.toggle"), "show or hide thinking", "toggle thinking"],
      [modelSelectable ? bound("app.model.select") : "", "pick a model"],
      [modelSelectable ? bound("app.model.cycleForward") : "", "take the next model", "next model"],
      providerUsage
        ? [bound("app.usage.toggle"), "show usage and cost", "usage and cost"]
        : [bound("app.usage.toggle"), "show session cost", "session cost"],
      [bound("app.editor.external"), "edit in $VISUAL"],
      [
        [bound("app.clear") && `${bound("app.clear")} twice`, bound("app.exit")].filter(Boolean).join("  "),
        "quit",
      ],
    ] satisfies readonly WelcomeRow[]
  ).filter(([keys]) => keys);
  const inner = Math.max(0, width - 2);
  // The key column fits the longest key shown, leaving room for the short descriptions.
  const keyColumn = Math.max(
    0,
    Math.min(Math.max(...rows.map(([keys]) => Bun.stringWidth(keys))) + KEY_GAP, inner - DOES_LEAST),
  );
  const room = inner - keyColumn;
  const short = rows.some(([, does, brief]) => brief !== undefined && Bun.stringWidth(does) > room);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      flexShrink={1}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <text selectable={false} fg={theme.dim} flexShrink={0}>
        Ask {agent} something to get started.
      </text>
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        {rows.map(([keys, does, brief]) => (
          <box key={keys} flexDirection="row" flexShrink={0} height={1}>
            <text selectable={false} fg={theme.tool} width={keyColumn} flexShrink={0} wrapMode="none">
              {ellipsize(keys, keyColumn - KEY_GAP)}
            </text>
            <text selectable={false} fg={theme.dim} wrapMode="none">
              {ellipsize(short && brief ? brief : does, room)}
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
  /** Local sessions can complete paths and choose models from the operator's configuration. */
  local?: boolean;
  /** What the operator calls the agent, such as `pi` or `the builder` for a Dura task's role. */
  agent: string;
  modelSelectable?: boolean;
  /** The footer's card shows the provider's usage beside the session's cost. */
  providerUsage?: boolean;
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

/** Prepending history adds rows above the viewport; a page back should reveal one page, not a whole batch. */
function useHistoryAnchor(
  ref: RefObject<ScrollBoxRenderable | null>,
  earlier: number,
  window: number,
  active: boolean,
) {
  const previous = useRef({ earlier, window });
  const pending = useRef<{ height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box && window > previous.current.window && earlier < previous.current.earlier) {
      pending.current = { height: box.scrollHeight, top: box.scrollTop };
    }
    previous.current = { earlier, window };
  }, [ref, earlier, window]);
  useLayoutEffect(() => {
    if (!active) return;
    const box = ref.current;
    if (!box) return;
    const resized = () => {
      const anchor = pending.current;
      if (!anchor) return;
      pending.current = null;
      // The content's own resize handler has updated the scrollbar before this event.
      box.scrollTo(anchor.top + box.scrollHeight - anchor.height - Math.max(1, Math.floor(box.height / 2)));
    };
    box.content.on("resize", resized);
    return () => {
      box.content.off("resize", resized);
    };
  }, [ref, active]);
  // A prepend can fold into an existing collapsed work box without changing height.
  // Its anchor belongs only to this frame, never a later unrelated resize.
  return () => {
    pending.current = null;
  };
}

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
  local,
  agent,
  modelSelectable,
  providerUsage,
  display,
  window,
  browsing,
  onLeave,
  ref,
}: ConversationProps) {
  const { height } = useTerminalDimensions();
  const earlier = Math.max(0, entries.length - window);
  const clearHistoryAnchor = useHistoryAnchor(ref, earlier, window, entries.length > 0);
  const items = useMemo(() => transcriptOf(entries.slice(earlier), running), [entries, earlier, running]);
  const boxes = items.filter((item): item is Work => item.kind === "work");
  const whole = display.expanded;
  const { isOpen, toggle } = useOpenBoxes(whole);
  const { selected, resized } = useWalk({ browsing, boxes, scroll: ref, isOpen, toggle, onLeave });

  if (entries.length === 0)
    return (
      <Welcome
        escapes={display.escapes}
        agent={agent}
        local={local}
        modelSelectable={modelSelectable}
        providerUsage={providerUsage}
      />
    );
  const rows = boxRows(height);
  return (
    <scrollbox
      ref={ref}
      flexGrow={1}
      flexBasis={0}
      flexShrink={1}
      stickyScroll
      stickyStart="bottom"
      scrollX={false}
      focusable={false}
      paddingLeft={1}
      paddingRight={1}
      verticalScrollbarOptions={SCROLLBAR}
      renderAfter={clearHistoryAnchor}
    >
      {earlier > 0 ? (
        <text selectable={false} fg={theme.dim} flexShrink={0}>
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
