import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useState } from "react";
import { glyphs } from "../glyphs.ts";
import { ellipsize } from "../text-width.ts";
import { theme } from "../theme.ts";

/** What the rules around the draft signal. */
export interface DraftSignal {
  /** A step away from the draft waits on the operator to ask for it again. */
  confirming?: boolean;
}

/** The colour of both rules around the draft. */
export function ruleColour(signal: DraftSignal): string {
  if (signal.confirming) return theme.user;
  return theme.border;
}

/** Rows the frame adds around the draft's own: a rule above and a rule below. */
export const FRAME_ROWS = 2;

/** Cells the mark takes with the gap after it, the same for every mark, so the draft never moves across. */
const MARK_COLS = 2;

export interface EditorFrameProps {
  signal: DraftSignal;
  /** Rows the draft itself takes. */
  rows: number;
  /** A passing message drawn into the rule above the draft. */
  note: string | null;
  /** What asking again does, drawn into the lit rule above the draft over any note. */
  confirm?: string | null;
  mark: Mark;
  children: ReactNode;
}

/** The mark before the draft, one cell such as `»`, and its colour. */
export interface Mark {
  label: string;
  tone: string;
}

/** The mark a draft carries outside any mode: the steering mark while pi works, `»` otherwise. */
export function draftMark(steering: boolean): Mark {
  if (steering) return { label: glyphs.steering, tone: theme.tool };
  return { label: "\u00bb", tone: theme.user };
}

/** The draft between two full-width rules, its mark at the left. */
export function EditorFrame({ signal, rows, note, confirm, mark, children }: EditorFrameProps) {
  const [width, setWidth] = useState(0);
  const confirming = Boolean(confirm);
  // OpenTUI leaves out a title that does not fit between two rule cells at each end.
  const title = ellipsize((confirming ? confirm : note) ?? "", width - 6);
  return (
    <box
      flexDirection="row"
      border={["top", "bottom"]}
      borderStyle="heavy"
      borderColor={ruleColour({ ...signal, confirming })}
      title={title ? ` ${title} ` : undefined}
      titleColor={confirming ? theme.assistant : theme.dim}
      onSizeChange={function (this: BoxRenderable) {
        setWidth(this.width);
      }}
      paddingLeft={1}
      paddingRight={1}
      height={rows + FRAME_ROWS}
      flexShrink={0}
    >
      <box width={MARK_COLS} flexShrink={0} overflow="hidden">
        <text fg={mark.tone} wrapMode="none" selectable={false}>
          {mark.label}
        </text>
      </box>
      {children}
    </box>
  );
}
