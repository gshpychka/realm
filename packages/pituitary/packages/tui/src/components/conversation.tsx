import { pathToFileURL } from "node:url";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { Entry, NoticeEntry } from "@pituitary/session";
import {
  Fragment,
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
import { explain } from "../errors.ts";
import { glyphs } from "../glyphs.ts";
import { hintLine } from "../hints.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { tilde } from "../place.ts";
import type { SkillOf } from "../skills.ts";
import { palette, theme } from "../theme.ts";
import { type Item, type Reply, transcriptOf, type Work } from "../transcript.ts";
import { type CursorKeys, cursorHints, joinKeys, type Stop, stopId, stopsOf } from "../transcript-cursor.ts";
import { useCursor } from "../use-cursor.ts";
import { useOpenBoxes } from "../use-open-boxes.ts";
import { parseUserText, skillsIn } from "../user-text.ts";
import { turnLine } from "../working.ts";
import { BashView } from "./bash.tsx";
import { Link } from "./link.tsx";
import { Markdown } from "./markdown.tsx";
import { UserMessage } from "./user-message.tsx";
import { Welcome } from "./welcome.tsx";
import { bodyRows, scrolls, scrollWork, WorkBox } from "./work.tsx";

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
  /**
   * The keys that stop the operator's running shell command: the interrupt's, unless it stops a
   * run, a retry, a compaction or a branch's summary first, when there are none.
   */
  shellStops: string;
  /** Commands the operator can run here, which an error's remedy may name. */
  commands: ReadonlySet<string>;
}

/** An entry the conversation draws as it is, which is any but the model's replies. */
type Plain = Exclude<Item, Work | Reply>;

const EntryView = memo(function EntryView({
  entry,
  display,
  rows,
  columns,
}: {
  entry: Plain;
  display: Display;
  /** Rows a shell command's output shows until ctrl+o. */
  rows: number;
  /** The terminal's width, which a shell command's output wraps within. */
  columns: number;
}) {
  const expand = useKeyHint("app.tools.expand");
  switch (entry.kind) {
    case "user":
      return <UserMessage entry={entry} expanded={display.expanded} />;
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
                {entry.of === "branch"
                  ? " summary of the branch you left"
                  : entry.tokensBefore === undefined
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
    case "bash":
      return (
        <BashView
          entry={entry}
          expanded={display.expanded}
          rows={rows}
          columns={columns}
          stops={display.shellStops}
        />
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
  const { text, remedy, detail } = explained(entry, commands);
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Marked mark={mark} colour={colour}>
        {/* The key that shows the rest flows after the remedy, so a wrapped remedy stays whole. */}
        <text fg={colour}>
          {text}
          {remedy ? <span fg={theme.assistant}> · {remedy}</span> : null}
          {detail && !expanded && expand ? <span fg={theme.dim}> · {expand}</span> : null}
        </text>
        {entry.file ? (
          <text fg={colour}>
            <Link href={pathToFileURL(entry.file).href}>{tilde(entry.file)}</Link>
          </text>
        ) : null}
        {detail && expanded ? <text fg={theme.dim}>{detail}</text> : null}
      </Marked>
    </box>
  );
}

/** A notice in the words it shows: an info as it is, a warning or error explained. */
const explained = (entry: NoticeEntry, commands: ReadonlySet<string>) =>
  entry.level === "info" ? { text: entry.text } : explain(entry.text, commands);

/** How a reply's note reads: a limit reached stands out, an interruption stays quiet. */
const NOTE_TONE = {
  warning: { mark: glyphs.warning, colour: theme.tool },
  quiet: { mark: " ", colour: theme.dim },
} as const;

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
          <Marked mark={NOTE_TONE[reply.note.tone].mark} colour={NOTE_TONE[reply.note.tone].colour}>
            <text fg={NOTE_TONE[reply.note.tone].colour}>{reply.note.text}</text>
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
  /** Regular Pi's saved sessions can be resumed, forked and started afresh. */
  sessions?: boolean;
  display: Display;
  /** The skill each file the model reads loads; without it, as in Dura, no read loads one. */
  skillOf?: SkillOf;
  /** How many of the latest entries are drawn; the earlier ones wait for the operator to scroll back. */
  window: number;
  /** The keyboard walks the conversation with the transcript cursor, the latest item selected first. */
  browsing: boolean;
  /** What the cursor's keys do beyond showing an item another way, such as copying it. */
  keys?: CursorKeys;
  /** The cursor's keys for its selection as a hint line in `hintColumns`, or null while it is away. */
  onHint?(hint: string | null): void;
  hintColumns?: number;
  /** Whether the viewport has left the conversation's latest rows below it. */
  onBelow?(below: boolean): void;
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

/**
 * What each frame of the scrollbox measures, once it is laid out and every size agrees: the rows
 * its content leaves empty below it, counting those the open box `last` takes beyond its bound,
 * which that box may then take; and whether rows of the conversation are out of view below.
 */
function useMeasures(last: string | null, onBelow: ((below: boolean) => void) | undefined) {
  const [room, setRoom] = useState(0);
  const measure = useCallback(
    (box: ScrollBoxRenderable) => {
      // The content is at least as tall as the viewport, so the rows its items take end at the last.
      const end = box.content.getChildren().at(-1);
      const used = end ? end.y + end.height - box.content.y : 0;
      const body = last ? bodyRows(box, { id: last }) : 0;
      setRoom(Math.max(0, box.viewport.height - used + body));
      onBelow?.(box.scrollHeight - box.viewport.height - box.scrollTop >= 1);
    },
    [last, onBelow],
  );
  return { room, measure };
}

/** Rows an open box shows before it scrolls: a third of the terminal, and never too few to read. */
const boxRows = (height: number) => Math.max(6, Math.floor(height / 3));
/**
 * Rows of output a shell command the operator ran shows until ctrl+o, its latest: half the
 * terminal, more than a box of the model's work, since the operator asked to see it.
 */
const shellRows = (height: number) => Math.max(6, Math.floor(height / 2));

/** Scrolls `work` by `by` rows while it has rows to give, and the conversation after, as the wheel does. */
function scrollThrough(view: ScrollBoxRenderable | null, work: Work, by: number): void {
  if (view && !scrollWork(view, work, by)) view.scrollBy(by);
}

/** How the cursor marks a selected item other than a box: a bar down its left, in the conversation's margin. */
function Selectable({
  stop,
  selected,
  onResized,
  children,
}: {
  stop: Stop;
  selected: boolean;
  onResized(id: string): void;
  children: ReactNode;
}) {
  const id = stopId(stop);
  return (
    <box id={id} flexDirection="column" flexShrink={0} onSizeChange={() => onResized(id)}>
      {children}
      {selected && stop.kind !== "work" ? (
        // Every item stands a row below the one before it; the bar runs beside the item alone.
        <box
          position="absolute"
          left={-1}
          top={1}
          bottom={0}
          width={1}
          border={["left"]}
          borderStyle="heavy"
          borderColor={theme.cursor}
        />
      ) : null}
    </box>
  );
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
  sessions,
  display,
  skillOf,
  window,
  browsing,
  keys = {},
  onHint,
  hintColumns = 80,
  onBelow,
  onLeave,
  ref,
}: ConversationProps) {
  const { width, height } = useTerminalDimensions();
  const earlier = Math.max(0, entries.length - window);
  const drawn = entries.length > 0;
  const clearHistoryAnchor = useHistoryAnchor(ref, earlier, window, drawn);
  const items = useMemo(
    () => transcriptOf(entries.slice(earlier), running, skillOf),
    [entries, earlier, running, skillOf],
  );
  const stops = useMemo(() => stopsOf(items), [items]);
  const stopOf = useMemo(() => new Map<Item, Stop>(stops.map((stop) => [stop.item, stop])), [stops]);
  const { isOpen, isWhole, toggle, stretch, last } = useOpenBoxes(display.expanded);
  // Items whose details the cursor showed, as ctrl+o shows every item's.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const flip = (id: string) =>
    setShown((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const showsMore = (id: string) => (shown.has(id) ? "fold" : "expand");
  const own: CursorKeys = {
    work: [
      {
        keys: ["enter", "space"],
        does: (work) => (isOpen(work) ? "close" : "open"),
        run: (work) => toggle(work.id, !isOpen(work)),
      },
      {
        keys: ["o"],
        does: (work) => (isOpen(work) && isWhole(work) ? "shorten" : "whole"),
        run: stretch,
      },
      {
        keys: ["j", "k"],
        label: "j k",
        does: () => "scroll",
        applies: (work) => isOpen(work) && !isWhole(work) && scrolls(ref.current, work),
        run: (work, key) => scrollThrough(ref.current, work, key === "j" ? 1 : -1),
      },
    ],
    prompt: [
      {
        keys: ["enter", "space"],
        does: (prompt) => (shown.has(prompt.id) ? "fold" : "show skill"),
        applies: (prompt) => !display.expanded && skillsIn(parseUserText(prompt.text)).length > 0,
        run: (prompt) => flip(prompt.id),
      },
    ],
    summary: [
      {
        keys: ["enter", "space"],
        does: (summary) => showsMore(summary.id),
        applies: () => !display.expanded,
        run: (summary) => flip(summary.id),
      },
    ],
    notice: [
      {
        keys: ["enter", "space"],
        does: (notice) => showsMore(notice.id),
        applies: (notice) =>
          !display.expanded &&
          notice.kind === "notice" &&
          explained(notice, display.commands).detail !== undefined,
        run: (notice) => flip(notice.id),
      },
    ],
  };
  const table = joinKeys(own, keys);
  const { selected, resized } = useCursor({ browsing, stops, keys: table, scroll: ref, onLeave });
  const hint = browsing ? hintLine(cursorHints(table, selected, "esc"), null, hintColumns) : null;
  useEffect(() => onHint?.(hint), [hint, onHint]);
  // The box opened last takes whatever rows the conversation leaves empty below it.
  const { room, measure } = useMeasures(last, onBelow);
  const expandedDisplay = useMemo(() => ({ ...display, expanded: true }), [display]);

  if (!drawn)
    return (
      <Welcome
        escapes={display.escapes}
        agent={agent}
        local={local}
        modelSelectable={modelSelectable}
        providerUsage={providerUsage}
        sessions={sessions}
      />
    );
  const rows = boxRows(height);
  const selectedId = selected ? stopId(selected) : null;
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
      renderAfter={function (this: ScrollBoxRenderable) {
        clearHistoryAnchor();
        measure(this);
      }}
    >
      {earlier > 0 ? (
        <text selectable={false} fg={theme.dim} flexShrink={0}>
          … {earlier} earlier entr{earlier === 1 ? "y" : "ies"} · pgup at the top shows more
        </text>
      ) : null}
      {items.map((item) => {
        const stop = stopOf.get(item);
        const view = (() => {
          switch (item.kind) {
            case "work":
              return (
                <WorkBox
                  work={item}
                  open={isOpen(item)}
                  whole={isWhole(item)}
                  thinking={display.thinking}
                  selected={stop !== undefined && stopId(stop) === selectedId}
                  rows={item.id === last ? Math.max(rows, room) : rows}
                  columns={width}
                  onToggle={toggle}
                />
              );
            case "reply":
              return <ReplyView reply={item} />;
            default:
              return (
                <EntryView
                  entry={item}
                  display={shown.has(item.id) ? expandedDisplay : display}
                  rows={shellRows(height)}
                  columns={width}
                />
              );
          }
        })();
        return stop ? (
          <Selectable key={item.id} stop={stop} selected={stopId(stop) === selectedId} onResized={resized}>
            {view}
          </Selectable>
        ) : (
          <Fragment key={item.id}>{view}</Fragment>
        );
      })}
    </scrollbox>
  );
}
