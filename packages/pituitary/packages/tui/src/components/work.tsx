import { type MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { memo, type ReactNode, useState } from "react";
import { glyphs } from "../glyphs.ts";
import { KeyHint } from "../keymap-context.tsx";
import { counted } from "../plural.ts";
import { ellipsize, headCells } from "../text-width.ts";
import { palette, theme } from "../theme.ts";
import { firstLine, took } from "../tools.ts";
import { rail, type Said, type Step, summary, type Work } from "../transcript.ts";
import { useNow } from "../use-now.ts";
import { Markdown } from "./markdown.tsx";
import { headingOf, STATE, stateMark, ToolCall } from "./tool-call.tsx";

export interface WorkBoxProps {
  work: Work;
  open: boolean;
  /** Every step at full length with no bound on the box: ctrl+o for every box, or `o` on this one. */
  whole: boolean;
  /** Thinking shown as text; a one-line marker otherwise, as ctrl+t asks. */
  thinking: boolean;
  /** Picked by the transcript cursor. */
  selected: boolean;
  /** Rows an open box shows before it scrolls. */
  rows: number;
  /** Cells the conversation's rows hold, which a call's heading fits within. */
  columns: number;
  /** Asks for the box to be `open`. */
  onToggle(id: string, open: boolean): void;
}

const bodyId = (work: Pick<Work, "id">) => `work-body:${work.id}`;

/**
 * Scrolls the open box drawing `work` inside `scroll` by `rows`; false when the box has
 * no rows to give that way, or scrolls none of its own.
 */
export function scrollWork(scroll: ScrollBoxRenderable, work: Pick<Work, "id">, rows: number): boolean {
  const body = bodyOf(scroll, work);
  if (!body || !room(body, rows)) return false;
  body.scrollBy(rows);
  return true;
}

/** Whether the open box drawing `work` inside `scroll` holds more rows than it shows. */
export function scrolls(scroll: ScrollBoxRenderable | null, work: Pick<Work, "id">): boolean {
  const body = scroll && bodyOf(scroll, work);
  return Boolean(body && body.scrollHeight > body.viewport.height);
}

/** The rows the open bounded box drawing `work` gives its steps; none for a box with no such body. */
export function bodyRows(scroll: ScrollBoxRenderable, work: Pick<Work, "id">): number {
  return bodyOf(scroll, work)?.height ?? 0;
}

function bodyOf(scroll: ScrollBoxRenderable, work: Pick<Work, "id">): ScrollBoxRenderable | null {
  const body = scroll.content.findDescendantById(bodyId(work));
  return body instanceof ScrollBoxRenderable ? body : null;
}

// Percentage heights in both the content and scrollbar otherwise resolve to maxHeight,
// turning a one-line box into a full-height empty viewport.
const SCROLLBAR = {
  trackOptions: { foregroundColor: palette.rule, backgroundColor: theme.bg, height: "auto" as const },
};

/**
 * A run's thinking, narration, and tool calls. Folded, one line saying what they come to, and
 * the call that failed when the last one did. While the model works in it, and until the
 * operator sends something after it, that line heads the latest steps, a row each. Open, that
 * line tops a rounded frame around every step. A press on the line opens or closes it.
 */
export const WorkBox = memo(function WorkBox({
  work,
  open,
  whole,
  thinking,
  selected,
  rows,
  columns,
  onToggle,
}: WorkBoxProps) {
  const frame = selected ? theme.cursor : theme.border;
  const steps = (
    <Steps steps={work.steps} whole={whole} thinking={thinking} width={columns - FRAME_COLUMNS} />
  );
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <Title
        work={work}
        open={open}
        selected={selected}
        frame={frame}
        columns={columns - MARGIN}
        onPress={() => onToggle(work.id, !open)}
      />
      {open ? (
        <box
          flexDirection="column"
          border={["left", "right", "bottom"]}
          borderStyle="rounded"
          borderColor={frame}
          paddingLeft={1}
          // A bounded box's scrollbar runs down its right edge, against the frame.
          paddingRight={whole ? 1 : 0}
        >
          {whole ? (
            steps
          ) : (
            <Body id={bodyId(work)} rows={rows} follow={work.live}>
              {steps}
            </Body>
          )}
        </box>
      ) : work.live || work.latest ? (
        <Rail work={work} thinking={thinking} columns={columns - MARGIN} />
      ) : (
        <Failure work={work} columns={columns - MARGIN} />
      )}
    </box>
  );
}, same);

/** Cells the conversation's padding and scrollbar take from each of its rows. */
export const MARGIN = 3;
/** Cells an open box's frame takes beside its title: its corners, and the least of its top rule. */
const TITLE_FRAME = 6;
/** Cells the latest steps are indented under the title by. */
const RAIL_INDENT = 2;
const SEPARATOR = " · ";

/**
 * `parts` joined by ` · ` and cut at their end to `cells`, an ellipsis last when any was cut;
 * each part keeps its own colour, so a failure stays red as far as it shows.
 */
function cut(parts: readonly Said[], cells: number): Said[] {
  const joined = parts.flatMap((part, index) => (index > 0 ? [{ text: SEPARATOR }, part] : [part]));
  if (Bun.stringWidth(joined.map((part) => part.text).join("")) <= cells) return joined;
  const shown: Said[] = [];
  let room = cells - 1;
  for (const [index, part] of joined.entries()) {
    const width = Bun.stringWidth(part.text);
    // A separator cut short says nothing, so the ellipsis stands apart after the part before it.
    if (width > room)
      return [
        ...shown,
        index % 2 === 1
          ? { text: room > 0 ? " …" : "…" }
          : { ...part, text: `${headCells(part.text, room)}…` },
      ];
    shown.push(part);
    room -= width;
  }
  return shown;
}

/**
 * The line a box folds into, which an open box draws as the top of its frame: what the work
 * comes to in `columns` cells, its failures in the error colour, cut at its end to fit.
 */
function Title({
  work,
  open,
  selected,
  frame,
  columns,
  onPress,
}: {
  work: Work;
  open: boolean;
  selected: boolean;
  frame: string;
  columns: number;
  onPress(): void;
}) {
  const icon = work.steps.some((step) => step.kind === "tool") ? glyphs.tool : glyphs.thinking;
  const tone = selected ? theme.cursor : theme.dim;
  // While the model works in it, the folded box leads with the running mark.
  const marker = open ? "▾" : work.live ? STATE.running.glyph : "▸";
  const lead = `${marker} ${icon} `;
  const parts = cut(summary(work), columns - (open ? TITLE_FRAME : 0) - Bun.stringWidth(lead));
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      onMouseDown={(event) => {
        if (event.button === 0) onPress();
      }}
    >
      {open ? (
        <text selectable={false} fg={frame} flexShrink={0}>
          ╭{" "}
        </text>
      ) : null}
      <text selectable={false} fg={tone} wrapMode="none" flexShrink={0}>
        <span fg={work.live && !open ? STATE.running.colour : tone}>{marker}</span> {icon}{" "}
        {parts.map((part, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a summary's parts are identified by position
          <span key={index} fg={part.failed ? theme.error : tone}>
            {part.text}
          </span>
        ))}
      </text>
      {open ? (
        <>
          <box flexGrow={1} minWidth={2} height={1} marginLeft={1} border={["top"]} borderColor={frame} />
          <text selectable={false} fg={frame} flexShrink={0}>
            ╮
          </text>
        </>
      ) : null}
    </box>
  );
}

/**
 * The latest steps under the title, a row each of `columns` cells, after how many came before
 * them. However much a step holds, it takes one row, and a running command a second for its
 * latest output.
 */
function Rail({ work, thinking, columns }: { work: Work; thinking: boolean; columns: number }) {
  const { steps, earlier } = rail(work);
  const cells = columns - RAIL_INDENT;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={RAIL_INDENT}>
      {earlier > 0 ? (
        <Row tone={theme.dim} text={`… ${counted(earlier, "earlier step")}`} cells={cells} />
      ) : null}
      {steps.map((step) => (
        <RailStep key={step.id} step={step} thinking={thinking} cells={cells} />
      ))}
    </box>
  );
}

/** One row of `text`, cut at its end to `cells`. */
function Row({
  tone,
  text,
  cells,
  italic = false,
}: {
  tone: string;
  text: string;
  cells: number;
  italic?: boolean;
}) {
  return (
    <box height={1} flexShrink={0}>
      <text selectable={false} fg={tone} wrapMode="none">
        {italic ? <i>{ellipsize(text, cells)}</i> : ellipsize(text, cells)}
      </text>
    </box>
  );
}

/** The last line of `text` with anything on it. */
const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .findLast(Boolean) ?? "";

function RailStep({ step, thinking, cells }: { step: Step; thinking: boolean; cells: number }) {
  switch (step.kind) {
    case "thinking":
      return thinking ? (
        <Row tone={theme.thinking} text={lastLine(step.text)} cells={cells} italic />
      ) : (
        <Row
          tone={theme.thinking}
          text={`${glyphs.thinking} ${step.done ? "thought" : "thinking…"}`}
          cells={cells}
        />
      );
    case "text":
      return <Row tone={palette.muted} text={lastLine(step.text)} cells={cells} />;
    case "tool":
      return <RailCall step={step} cells={cells} />;
  }
}

/** Cells a heading's first line keeps before the count of the lines after it gives way to it. */
const LEAST_LINE = 12;

/**
 * A heading's detail on one row of `room` cells: its first line, then how many lines it leaves
 * out, which gives way first when the row is short.
 */
function oneLine(detail: string, room: number): { line: string; more: string } {
  const { line, more } = firstLine(detail);
  const fits = more !== "" && room - Bun.stringWidth(more) >= Math.min(LEAST_LINE, Bun.stringWidth(line));
  return fits
    ? { line: ellipsize(line, room - Bun.stringWidth(more)), more }
    : { line: ellipsize(line, room), more: "" };
}

/**
 * A call on one row as its heading reads, cut to leave its time whole, and a running command's
 * latest output on the next.
 */
function RailCall({ step, cells }: { step: Extract<Step, { kind: "tool" }>; cells: number }) {
  const { tool, skill } = step;
  const { title, detail, icon } = headingOf(tool, skill);
  const mark = stateMark(tool);
  const running = tool.state === "running" && tool.endedAt === undefined;
  const elapsed = took(tool, useNow(running));
  const output = running && tool.name === "bash" ? lastLine(tool.output) : "";
  const lead = `${mark.glyph} ${icon ? `${glyphs[icon]} ` : ""}${title} `;
  const time = elapsed ? `${SEPARATOR}${elapsed}` : "";
  const { line, more } = oneLine(detail, cells - Bun.stringWidth(lead) - Bun.stringWidth(time));
  return (
    <>
      <box height={1} flexShrink={0}>
        <text selectable={false} fg={theme.assistant} wrapMode="none">
          <span fg={mark.colour}>{mark.glyph}</span>{" "}
          {icon ? <span fg={skill ? theme.skill : theme.tool}>{glyphs[icon]} </span> : null}
          <span fg={theme.tool}>{title}</span> {line}
          {more ? <span fg={theme.dim}>{more}</span> : null}
          {time ? <span fg={theme.dim}>{time}</span> : null}
        </text>
      </box>
      {output ? (
        <box paddingLeft={2} flexShrink={0}>
          <Row tone={theme.dim} text={output} cells={cells - 2} />
        </box>
      ) : null}
    </>
  );
}

/**
 * Under a folded box, in `columns` cells, its last call when that one failed, so a failure that
 * ended a turn shows; one the operator's interruption ended shows dim.
 */
function Failure({ work, columns }: { work: Work; columns: number }) {
  const last = work.steps.findLast((step) => step.kind === "tool");
  if (last?.tool.state !== "error") return null;
  const { title, detail } = headingOf(last.tool, last.skill);
  const mark = stateMark(last.tool);
  const lead = `${mark.glyph} ${title} `;
  const { line, more } = oneLine(detail, columns - RAIL_INDENT - Bun.stringWidth(lead));
  return (
    <box height={1} flexShrink={0} paddingLeft={RAIL_INDENT}>
      <text selectable={false} fg={mark.colour} wrapMode="none">
        {lead}
        {line}
        {more ? <span fg={theme.dim}>{more}</span> : null}
      </text>
    </box>
  );
}

/**
 * The steps in at most `rows` rows, which the wheel scrolls before the conversation around
 * it. A box the model is still working in starts at its latest step and follows the steps
 * as they come; any other starts at its first.
 */
function Body({
  id,
  rows,
  follow,
  children,
}: {
  id: string;
  rows: number;
  follow: boolean;
  children: ReactNode;
}) {
  const [start] = useState<"top" | "bottom">(follow ? "bottom" : "top");
  return (
    <scrollbox
      id={id}
      maxHeight={rows}
      contentOptions={{ minHeight: 0 }}
      stickyScroll
      stickyStart={start}
      scrollX={false}
      focusable={false}
      verticalScrollbarOptions={SCROLLBAR}
      onMouseScroll={handOver}
    >
      {children}
    </scrollbox>
  );
}

/** Whether `box` has rows to scroll toward `by`: up when negative, down when positive. */
function room(box: ScrollBoxRenderable, by: number): boolean {
  return by < 0 ? box.scrollTop > 0 : box.scrollTop < box.scrollHeight - box.viewport.height;
}

/** A wheel turn the box has room for stops at the box; at its end, the conversation scrolls instead. */
function handOver(this: ScrollBoxRenderable, event: MouseEvent) {
  const direction = event.scroll?.direction;
  if ((direction === "up" || direction === "down") && room(this, direction === "up" ? -1 : 1)) {
    event.stopPropagation();
  }
}

/** Cells an open box's frame, padding and scrollbar take from each row of its steps. */
const FRAME_COLUMNS = 6;

/** A step that reads as a block of its own: thinking shown as text, or narration of several lines. */
const block = (step: Step, thinking: boolean) =>
  (step.kind === "thinking" && thinking) || (step.kind === "text" && step.text.trim().includes("\n"));

/**
 * Every step, one after another, a row apart only before a block of text. While thinking is
 * hidden, thinking that led to a call marks that call's heading rather than taking a row.
 */
function Steps({
  steps,
  whole,
  thinking,
  width,
}: {
  steps: Step[];
  whole: boolean;
  thinking: boolean;
  /** Cells each step's rows hold. */
  width: number;
}) {
  const leadsToCall = (index: number) =>
    steps.slice(index).find((step) => step.kind !== "thinking")?.kind === "tool";
  const shown = steps.flatMap((step, index) => {
    if (!thinking && step.kind === "thinking" && leadsToCall(index)) return [];
    const thought = !thinking && step.kind === "tool" && steps[index - 1]?.kind === "thinking";
    return [{ step, thought }];
  });
  return (
    <>
      {shown.map(({ step, thought }, index) => (
        <box
          key={step.id}
          flexDirection="column"
          flexShrink={0}
          marginTop={index > 0 && block(step, thinking) ? 1 : 0}
        >
          <StepView step={step} whole={whole} thinking={thinking} thought={thought} width={width} />
        </box>
      ))}
    </>
  );
}

function StepView({
  step,
  whole,
  thinking,
  thought,
  width,
}: {
  step: Step;
  whole: boolean;
  thinking: boolean;
  thought: boolean;
  width: number;
}) {
  switch (step.kind) {
    case "thinking":
      return thinking ? (
        <text fg={theme.thinking}>
          <i>{step.text}</i>
        </text>
      ) : (
        <text selectable={false} fg={theme.thinking}>
          {glyphs.thinking}{" "}
          {step.done ? `thought · ${counted(step.text.split("\n").length, "line")}` : "thinking…"}
          <KeyHint action="app.thinking.toggle" />
        </text>
      );
    case "text":
      return <Markdown content={step.text} />;
    case "tool":
      return (
        <ToolCall tool={step.tool} skill={step.skill} expanded={whole} width={width} thought={thought} />
      );
  }
}

function sameStep(a: Step, b: Step | undefined): boolean {
  if (!b || a.kind !== b.kind || a.id !== b.id) return false;
  if (a.kind === "tool") return b.kind === "tool" && a.tool === b.tool && a.skill === b.skill;
  if (a.kind === "thinking") return b.kind === "thinking" && a.text === b.text && a.done === b.done;
  return b.kind === "text" && a.text === b.text;
}

/** A box redraws when a step in it changes, and not because the list around it was rebuilt. */
function same(before: WorkBoxProps, after: WorkBoxProps): boolean {
  const { work: a, ...rest } = before;
  const { work: b, ...next } = after;
  return (
    a.id === b.id &&
    a.live === b.live &&
    a.latest === b.latest &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => sameStep(step, b.steps[index])) &&
    (Object.keys(rest) as (keyof typeof rest)[]).every((key) => rest[key] === next[key])
  );
}
