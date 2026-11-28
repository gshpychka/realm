import { plain, type SessionView } from "@pituitary/session";
import { memo, useMemo } from "react";
import { type OpinionEntry, questionLine } from "../consult/consult.ts";
import { type LiveConsult, roundOf, working } from "../consult/consults.ts";
import { glyphs } from "../glyphs.ts";
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

/** What marks a second opinion, under way and recorded. */
const MARK = "◆";

/** Cells each card needs across to stand beside the others; narrower, they stand one above another. */
const BESIDE = 60;
/** Cells between cards standing side by side. */
const GAP = 1;
/** Cells a card's frame and padding take across. */
const FRAME = 4;

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
      return `${name} · recorded · it joins the conversation as the turn ends`;
    case "failed":
      return `${name} · failed`;
  }
}

/**
 * A second opinion under way, in a rounded frame the cursor colours: its model, how long it has
 * worked and what it does in the title, the question on one dim row, then its latest steps a row
 * each and its reply as it streams, as the conversation draws its own agent's. A failed one says
 * why, in Pi's words.
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
  const items = useMemo(
    () => roundOf(view.entries, consult.round, view.running),
    [view.entries, view.running, consult.round],
  );
  const inner = width - FRAME;
  const tone = selected ? theme.cursor : theme.border;
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width}
      marginTop={1}
      border
      borderStyle="rounded"
      borderColor={tone}
      title={ellipsize(` ${MARK} ${titled(consult, view, now)} `, width - 2)}
      titleColor={selected ? theme.cursor : theme.opinion}
      paddingLeft={1}
      paddingRight={1}
    >
      <text selectable={false} fg={theme.dim} wrapMode="none">
        {ellipsize(plain(questionLine(consult.question)), inner)}
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
          <box key={item.id} flexShrink={0} marginTop={1}>
            <Markdown content={item.text} streaming={item.streaming} />
          </box>
        ) : null,
      )}
      {consult.error ? (
        <box flexShrink={0} marginTop={1}>
          <text fg={theme.error}>{plain(consult.error)}</text>
        </box>
      ) : null}
    </box>
  );
}

/**
 * A second opinion in the conversation's record: the model that weighs in, the question it was
 * asked, its answer, and what answering took.
 */
export const OpinionView = memo(function OpinionView({ entry }: { entry: OpinionEntry }) {
  const opinion = entry.details;
  // A provider that reports no usage leaves the tokens unknown rather than none.
  const took = [
    counted(opinion.tools, "tool call"),
    dollars(opinion.cost),
    ...(opinion.tokens > 0 ? [`${glyphs.tokens} ${count(opinion.tokens)}`] : []),
  ].join(" · ");
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1} paddingLeft={2}>
      <text selectable={false} position="absolute" left={0} top={0} fg={theme.opinion} width={2}>
        {MARK}
      </text>
      <text fg={theme.opinion}>{plain(opinionModel(opinion))} weighs in</text>
      <text fg={theme.dim}>{plain(questionLine(opinion.question))}</text>
      <box flexShrink={0} marginTop={1}>
        <Markdown content={opinion.answer} />
      </box>
      <text selectable={false} fg={theme.dim}>
        {took}
      </text>
    </box>
  );
});
