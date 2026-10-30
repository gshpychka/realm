import { type CursorStyle, TextAttributes } from "@opentui/core";
import type { CursorForm, Frame, Highlight, Run } from "../nvim/screen.ts";

/** The terminal cursor that stands for each of nvim's cursor forms. */
const CURSOR = {
  block: "block",
  vertical: "line",
  horizontal: "underline",
} as const satisfies Record<CursorForm, CursorStyle>;

/** The attribute each highlight flag draws with. OpenTUI has one underline, which stands for all of nvim's. */
const ATTRIBUTES: [keyof Highlight, number][] = [
  ["bold", TextAttributes.BOLD],
  ["dim", TextAttributes.DIM],
  ["italic", TextAttributes.ITALIC],
  ["blink", TextAttributes.BLINK],
  ["reverse", TextAttributes.INVERSE],
  ["strikethrough", TextAttributes.STRIKETHROUGH],
  ["underline", TextAttributes.UNDERLINE],
  ["undercurl", TextAttributes.UNDERLINE],
  ["underdouble", TextAttributes.UNDERLINE],
  ["underdotted", TextAttributes.UNDERLINE],
  ["underdashed", TextAttributes.UNDERLINE],
];

const hex = (rgb: number | undefined) =>
  rgb === undefined ? undefined : `#${rgb.toString(16).padStart(6, "0")}`;

/** How text in `highlight` draws, the frame's own colours standing in for any it leaves out. */
function styleOf(highlight: Highlight, colors: Frame["colors"]) {
  return {
    fg: hex(highlight.foreground ?? colors.foreground),
    bg: hex(highlight.background ?? colors.background),
    attributes: ATTRIBUTES.reduce(
      (all, [flag, bit]) => (highlight[flag] ? all | bit : all),
      TextAttributes.NONE,
    ),
  };
}

/** The terminal cursor as `NvimScreen` places it, or null where it is hidden. */
export interface Cursor {
  x: number;
  y: number;
  style: CursorStyle;
  blinking: boolean;
}

/** Where the terminal's cursor goes among the rows `NvimScreen` draws for `frame`, and how it looks. */
export function cursorOf(frame: Frame | null): Cursor | null {
  if (!frame) return null;
  const look = { style: CURSOR[frame.mode.cursor], blinking: frame.mode.blinking };
  // The command line, while open, holds the cursor in the row below the buffer's.
  if (frame.cmdline) return { x: frame.cmdline.cursor, y: frame.rows.length, ...look };
  return frame.cursor && { x: frame.cursor.col, y: frame.cursor.row, ...look };
}

/** Rows `NvimScreen` takes for `frame`: at least one, and one more while a command line is open. */
export function heightOf(frame: Frame | null): number {
  return Math.max(1, frame?.rows.length ?? 0) + (frame?.cmdline ? 1 : 0);
}

/** Attributes that draw on a blank cell. */
const VISIBLE_BLANK = TextAttributes.INVERSE | TextAttributes.UNDERLINE | TextAttributes.STRIKETHROUGH;

/**
 * The row without the blank cells at its end that draw nothing, so a selection copies the
 * text alone, as a terminal's does.
 */
export function trimmed(runs: Run[], colors: Frame["colors"]): Run[] {
  const kept = [...runs];
  for (let last = kept.pop(); last; last = kept.pop()) {
    const { bg, attributes } = styleOf(last.highlight, colors);
    const draws = bg !== undefined || (attributes & VISIBLE_BLANK) !== 0;
    const text = draws ? last.text : last.text.replace(/ +$/, "");
    if (text) return [...kept, { ...last, text }];
  }
  return kept;
}

/** One screen row as nvim drew it. */
function ScreenRow({
  runs,
  colors,
  selectable,
}: {
  runs: Run[];
  colors: Frame["colors"];
  selectable: boolean;
}) {
  return (
    <text wrapMode="none" flexShrink={0} selectable={selectable}>
      {trimmed(runs, colors).map((run, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: runs are identified by position along their row
        <span key={index} {...styleOf(run.highlight, colors)}>
          {run.text}
        </span>
      ))}
    </text>
  );
}

/** A frame nvim drew: its rows, which a mouse selection takes when `selectable`, then the command line while one is open. */
export function NvimScreen({ frame, selectable }: { frame: Frame; selectable: boolean }) {
  return (
    <>
      {frame.rows.map((runs, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: screen rows are identified by position
        <ScreenRow key={index} runs={runs} colors={frame.colors} selectable={selectable} />
      ))}
      {frame.cmdline ? (
        <text {...styleOf({}, frame.colors)} wrapMode="none" truncate flexShrink={0} selectable={false}>
          {frame.cmdline.text}
        </text>
      ) : null}
    </>
  );
}
