import { type MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { memo, type ReactNode, useState } from "react";
import { glyphs } from "../glyphs.ts";
import { KeyHint } from "../keymap-context.tsx";
import { palette, theme } from "../theme.ts";
import { type Step, summary, type Work } from "../transcript.ts";
import { Markdown } from "./markdown.tsx";
import { ToolCall } from "./tool-call.tsx";

export interface WorkBoxProps {
  work: Work;
  open: boolean;
  /** Every step at full length with no bound on the box, as ctrl+o asks. */
  whole: boolean;
  /** Thinking shown as text; a one-line marker otherwise, as ctrl+t asks. */
  thinking: boolean;
  /** Picked from the keyboard. */
  selected: boolean;
  /** Rows an open box shows before it scrolls. */
  rows: number;
  /** Asks for the box to be `open`. */
  onToggle(id: string, open: boolean): void;
  /** The box took up a new number of rows. */
  onResized(id: string): void;
}

/** The renderable id of the box drawing `work`, which a scroll can bring into view. */
export const boxId = (work: Pick<Work, "id">) => `work:${work.id}`;
const bodyId = (work: Pick<Work, "id">) => `work-body:${work.id}`;

/**
 * Scrolls the open box drawing `work` inside `scroll` by `rows`; false when the box has
 * no rows to give that way, or scrolls none of its own.
 */
export function scrollWork(scroll: ScrollBoxRenderable, work: Pick<Work, "id">, rows: number): boolean {
  const body = scroll.content.findDescendantById(bodyId(work));
  if (!(body instanceof ScrollBoxRenderable) || !room(body, rows)) return false;
  body.scrollBy(rows);
  return true;
}

// Percentage heights in both the content and scrollbar otherwise resolve to maxHeight,
// turning a one-line box into a full-height empty viewport.
const SCROLLBAR = {
  trackOptions: { foregroundColor: palette.rule, backgroundColor: theme.bg, height: "auto" as const },
};

/**
 * A run's thinking, narration, and tool calls: one line saying what they come to, or that
 * line as the top of a rounded frame around the steps themselves. A press on the line opens
 * or closes it.
 */
export const WorkBox = memo(function WorkBox({
  work,
  open,
  whole,
  thinking,
  selected,
  rows,
  onToggle,
  onResized,
}: WorkBoxProps) {
  const frame = selected ? theme.user : theme.border;
  const steps = <Steps steps={work.steps} whole={whole} thinking={thinking} />;
  return (
    <box
      id={boxId(work)}
      flexDirection="column"
      flexShrink={0}
      marginTop={1}
      onSizeChange={() => onResized(work.id)}
    >
      <Title
        work={work}
        open={open}
        selected={selected}
        frame={frame}
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
      ) : null}
    </box>
  );
}, same);

/** The line a box folds into, which an open box draws as the top of its frame. */
function Title({
  work,
  open,
  selected,
  frame,
  onPress,
}: {
  work: Work;
  open: boolean;
  selected: boolean;
  frame: string;
  onPress(): void;
}) {
  const icon = work.steps.some((step) => step.kind === "tool") ? glyphs.tool : glyphs.thinking;
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={selected && !open ? palette.surface : undefined}
      onMouseDown={(event) => {
        if (event.button === 0) onPress();
      }}
    >
      {open ? (
        <text fg={frame} flexShrink={0}>
          ╭{" "}
        </text>
      ) : null}
      <text fg={selected ? theme.user : theme.dim} wrapMode="none" truncate flexShrink={1}>
        {open ? "▾" : "▸"} {icon} {summary(work)}
      </text>
      {open ? (
        <>
          <box flexGrow={1} minWidth={2} height={1} marginLeft={1} border={["top"]} borderColor={frame} />
          <text fg={frame} flexShrink={0}>
            ╮
          </text>
        </>
      ) : null}
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

function Steps({ steps, whole, thinking }: { steps: Step[]; whole: boolean; thinking: boolean }) {
  return (
    <>
      {steps.map((step, index) => {
        const before = steps[index - 1];
        // Tool calls stack; thinking and narration stand a row apart from what is around them.
        const gap = before && (before.kind !== "tool" || step.kind !== "tool") ? 1 : 0;
        return (
          <box key={step.id} flexDirection="column" flexShrink={0} marginTop={gap}>
            <StepView step={step} whole={whole} thinking={thinking} />
          </box>
        );
      })}
    </>
  );
}

function StepView({ step, whole, thinking }: { step: Step; whole: boolean; thinking: boolean }) {
  switch (step.kind) {
    case "thinking":
      return thinking ? (
        <text fg={theme.thinking} selectable>
          <i>{step.text}</i>
        </text>
      ) : (
        <text fg={theme.thinking}>
          {glyphs.thinking} thinking…
          <KeyHint action="app.thinking.toggle" />
        </text>
      );
    case "text":
      return <Markdown content={step.text} />;
    case "tool":
      return <ToolCall tool={step.tool} expanded={whole} />;
  }
}

function sameStep(a: Step, b: Step | undefined): boolean {
  if (!b || a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind === "tool" ? b.kind === "tool" && a.tool === b.tool : b.kind !== "tool" && a.text === b.text;
}

/** A box redraws when a step in it changes, and not because the list around it was rebuilt. */
function same(before: WorkBoxProps, after: WorkBoxProps): boolean {
  const { work: a, ...rest } = before;
  const { work: b, ...next } = after;
  return (
    a.id === b.id &&
    a.live === b.live &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => sameStep(step, b.steps[index])) &&
    (Object.keys(rest) as (keyof typeof rest)[]).every((key) => rest[key] === next[key])
  );
}
