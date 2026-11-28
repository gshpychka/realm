import type { BoxRenderable } from "@opentui/core";
import { plain, type SessionView } from "@pituitary/session";
import { memo, useMemo, useState } from "react";
import type { OpinionEntry } from "../consult/consult.ts";
import { failed, type LiveConsult, roundOf, working } from "../consult/consults.ts";
import { glyphs } from "../glyphs.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { modelName } from "../model-names.ts";
import { opinionModel } from "../pi-bridge.ts";
import { counted } from "../plural.ts";
import { ellipsize } from "../text-width.ts";
import { theme } from "../theme.ts";
import { useNow } from "../use-now.ts";
import { useSession } from "../use-session.ts";
import { count, dollars, duration, workingLine } from "../working.ts";
import { Markdown } from "./markdown.tsx";
import { MARGIN, WorkBox } from "./work.tsx";

/** Cells each card needs across to stand beside the others; narrower, they stand one above another. */
const BESIDE = 60;
/** Cells between cards standing side by side. */
const GAP = 1;
/** Cells a card's frame and padding take across. */
const FRAME = 4;
/** Cells a card's top rule takes beside its title and the spaces around it: `╭─` before, at least `─╮` after. */
const TITLE_FRAME = 6;
/**
 * Rows of its reply a card shows while the answer is on its way, the latest: the whole answer
 * is the opinion's, which the conversation draws once it is recorded.
 */
const REPLY_ROWS = 5;

/**
 * How `cards` share the conversation's `columns`: side by side when each gets `BESIDE` cells,
 * otherwise one above another, each `width` cells across, `gap` apart.
 */
export function consultLayout(
  columns: number,
  cards: number,
): { beside: boolean; width: number; gap: number } {
  // The conversation's padding and scrollbar take their cells from each row.
  const room = columns - MARGIN;
  const each = Math.floor((room - GAP * (cards - 1)) / Math.max(1, cards));
  const beside = cards > 1 && each >= BESIDE;
  return { beside, width: beside ? each : room, gap: beside ? GAP : 0 };
}

/** What a card's title says: the model, how long it has worked, and what it is doing, or how it stands. */
function titled(consult: LiveConsult, view: SessionView, now: number): string {
  const name = modelName(consult.model);
  switch (consult.status) {
    case "starting":
      return `${name} · starting`;
    case "answering":
      return `${name} · ${duration(now - consult.at)} · ${workingLine(view, now, "", Number.POSITIVE_INFINITY).doing}`;
    case "recording":
      return `${name} · recording its opinion`;
    case "recorded":
      return `${name} · recorded · joins as the turn ends`;
    case "failed":
      return `${name} · failed`;
  }
}

/**
 * A second opinion under way, in a rounded frame the cursor colours: its model, how long it has
 * worked and what it does in the title, the question's topic on one dim row, then its latest
 * steps a row each and the latest rows of its reply as it streams, as the conversation draws its
 * own agent's. A failed one keeps all it said, says why in Pi's words, and how it goes.
 */
export function ConsultCard({
  consult,
  selected,
  width,
  thinking,
}: {
  consult: LiveConsult;
  /** Picked by the transcript cursor. */
  selected: boolean;
  /** Cells the card takes across. */
  width: number;
  /** Thinking shown as text, as ctrl+t asks. */
  thinking: boolean;
}) {
  // The consultant's conversation is read as the main one is, from its own snapshots and events.
  const { view } = useSession(consult.link);
  const now = useNow(working(consult));
  const browse = useKeyHint("app.tools.browse");
  const items = useMemo(
    () => roundOf(view.entries, consult.round, view.running),
    [view.entries, view.running, consult.round],
  );
  const inner = width - FRAME;
  const frame = selected ? theme.cursor : theme.border;
  const tone = selected ? theme.cursor : failed(consult) ? theme.error : theme.opinion;
  // The title is a row of its own, as a box of work's is: a frame's own title, though cut to its
  // cells, can hold more bytes than the frame draws, and then the frame draws none of it.
  const title = ellipsize(`${glyphs.opinion} ${titled(consult, view, now)}`, width - TITLE_FRAME);
  return (
    <box flexDirection="column" flexShrink={0} width={width} marginTop={1}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text selectable={false} fg={frame} flexShrink={0}>
          ╭─
        </text>
        <text selectable={false} fg={tone} flexShrink={0} wrapMode="none">
          {` ${title} `}
        </text>
        <box flexGrow={1} minWidth={1} height={1} border={["top"]} borderColor={frame} />
        <text selectable={false} fg={frame} flexShrink={0}>
          ╮
        </text>
      </box>
      <box
        flexDirection="column"
        flexShrink={0}
        border={["left", "right", "bottom"]}
        borderStyle="rounded"
        borderColor={frame}
        paddingLeft={1}
        paddingRight={1}
      >
        <text selectable={false} fg={theme.dim} wrapMode="none">
          {ellipsize(plain(consult.topic), inner)}
        </text>
        {items.map((item) =>
          item.kind === "work" ? (
            <WorkBox
              key={item.id}
              work={item}
              open={false}
              whole={false}
              thinking={thinking}
              selected={false}
              rows={0}
              // The box words its rows as the conversation's, which lose its margin.
              columns={inner + MARGIN}
              onToggle={() => {}}
            />
          ) : item.kind === "reply" && item.text ? (
            <Reply
              key={item.id}
              text={item.text}
              streaming={item.streaming}
              // What a failed consultant said is not recorded, so its card keeps all of it.
              rows={failed(consult) ? undefined : REPLY_ROWS}
            />
          ) : null,
        )}
        {consult.error ? (
          <box flexDirection="column" flexShrink={0} marginTop={1}>
            <text fg={theme.error}>{plain(consult.error)}</text>
            <text selectable={false} fg={theme.dim} wrapMode="none">
              {ellipsize(`your next prompt clears it${browse ? `, or x under ${browse}` : ""}`, inner)}
            </text>
          </box>
        ) : null}
      </box>
    </box>
  );
}

/** A consultant's reply: its latest `rows` rows after how many came before them, or all of it without `rows`. */
function Reply({ text, streaming, rows }: { text: string; streaming: boolean; rows?: number }) {
  // The reply's own height, which the rows it leaves out are counted from.
  const [height, setHeight] = useState(0);
  const earlier = rows === undefined ? 0 : Math.max(0, height - rows);
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      {earlier > 0 ? (
        <text selectable={false} fg={theme.dim} wrapMode="none">
          … {counted(earlier, "earlier line")}
        </text>
      ) : null}
      {/* Its end against the bottom and what is above cut off, so the latest of it shows. */}
      <box
        flexDirection="column"
        flexShrink={0}
        justifyContent="flex-end"
        overflow="hidden"
        {...(rows === undefined ? {} : { maxHeight: rows })}
      >
        <box
          flexShrink={0}
          onSizeChange={function (this: BoxRenderable) {
            setHeight(this.height);
          }}
        >
          <Markdown content={text} streaming={streaming} />
        </box>
      </box>
    </box>
  );
}

/**
 * A second opinion in the conversation's record: the model that weighs in, what it was asked
 * about on one row, its answer, and what answering took where it took anything.
 */
export const OpinionView = memo(function OpinionView({
  entry,
  columns,
}: {
  entry: OpinionEntry;
  /** The conversation's width, which the topic's one row is cut to. */
  columns: number;
}) {
  const opinion = entry.details;
  // A provider that reports no usage leaves the tokens unknown rather than none.
  const took = [
    ...(opinion.tools > 0 ? [counted(opinion.tools, "tool call")] : []),
    ...(opinion.cost > 0 ? [dollars(opinion.cost)] : []),
    ...(opinion.tokens > 0 ? [`${glyphs.tokens} ${count(opinion.tokens)}`] : []),
  ].join(" · ");
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1} paddingLeft={2}>
      <text selectable={false} position="absolute" left={0} top={0} fg={theme.opinion} width={2}>
        {glyphs.opinion}
      </text>
      <text fg={theme.opinion}>{plain(opinionModel(opinion))} weighs in</text>
      {/* The conversation's margin and the mark's indent take their cells from the row. */}
      <text fg={theme.dim} wrapMode="none">
        {ellipsize(plain(opinion.topic), columns - MARGIN - 2)}
      </text>
      <box flexShrink={0} marginTop={1}>
        <Markdown content={opinion.answer} />
      </box>
      {took ? (
        <text selectable={false} fg={theme.dim}>
          {took}
        </text>
      ) : null}
    </box>
  );
});
