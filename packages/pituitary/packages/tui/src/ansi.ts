import { TextAttributes } from "@opentui/core";
import { palette } from "./theme.ts";

/** A stretch of text drawn in one style. Colours are hex; absent means the surface's own. */
export interface Run {
  text: string;
  fg?: string;
  bg?: string;
  attributes: number;
}

/** The sixteen terminal colours, in the operator's palette. */
const BASIC = [
  palette.bg,
  palette.red,
  palette.green,
  palette.yellow,
  palette.blue,
  palette.purple,
  palette.aqua,
  palette.muted,
  palette.faint,
  palette.red,
  palette.green,
  palette.yellow,
  palette.blue,
  palette.purple,
  palette.aqua,
  palette.text,
] as const;

// Escape sequences a component may emit: SGR is kept, every other kind is dropped.
const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
  /\x1b\[([0-9;:?]*)([@-~])|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P_^X][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal controls is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** pi's components measure a tab as three cells, so a tab becomes three spaces to keep their columns. */
const TAB = "   ";

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((part) => Math.max(0, Math.min(255, part)).toString(16).padStart(2, "0")).join("")}`;

/** The xterm 256-colour table. */
function indexed(index: number): string | undefined {
  if (index < 16) return BASIC[index];
  if (index < 232) {
    const step = [0, 95, 135, 175, 215, 255];
    const n = index - 16;
    return hex(step[Math.floor(n / 36)] ?? 0, step[Math.floor(n / 6) % 6] ?? 0, step[n % 6] ?? 0);
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return hex(level, level, level);
  }
  return undefined;
}

interface Style {
  fg?: string;
  bg?: string;
  attributes: number;
}

/** Applies one SGR parameter list to `style`. */
function apply(style: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((part) => Number(part || "0"));
  let next = { ...style };
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at] ?? 0;
    if (code === 0) next = { attributes: 0 };
    else if (code === 1) next.attributes |= TextAttributes.BOLD;
    else if (code === 2) next.attributes |= TextAttributes.DIM;
    else if (code === 3) next.attributes |= TextAttributes.ITALIC;
    else if (code === 4) next.attributes |= TextAttributes.UNDERLINE;
    else if (code === 7) next.attributes |= TextAttributes.INVERSE;
    else if (code === 9) next.attributes |= TextAttributes.STRIKETHROUGH;
    else if (code === 22) next.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM);
    else if (code === 23) next.attributes &= ~TextAttributes.ITALIC;
    else if (code === 24) next.attributes &= ~TextAttributes.UNDERLINE;
    else if (code === 27) next.attributes &= ~TextAttributes.INVERSE;
    else if (code === 29) next.attributes &= ~TextAttributes.STRIKETHROUGH;
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30];
    else if (code >= 90 && code <= 97) next.fg = BASIC[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40];
    else if (code >= 100 && code <= 107) next.bg = BASIC[code - 100 + 8];
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if (code === 38 || code === 48) {
      const mode = codes[at + 1];
      let colour: string | undefined;
      if (mode === 5) {
        colour = indexed(codes[at + 2] ?? 0);
        at += 2;
      } else if (mode === 2) {
        colour = hex(codes[at + 2] ?? 0, codes[at + 3] ?? 0, codes[at + 4] ?? 0);
        at += 4;
      }
      if (code === 38) next.fg = colour;
      else next.bg = colour;
    }
  }
  return next;
}

/**
 * One row of a component's drawing as styled runs. Colours and text attributes survive;
 * cursor movement, hyperlinks, titles, and any other escape are dropped.
 */
export function parseAnsi(line: string): Run[] {
  const runs: Run[] = [];
  let style: Style = { attributes: 0 };
  const push = (text: string) => {
    const clean = text.replaceAll("\t", TAB).replace(CONTROL, "");
    if (!clean) return;
    const last = runs.at(-1);
    if (last && last.fg === style.fg && last.bg === style.bg && last.attributes === style.attributes) {
      last.text += clean;
    } else runs.push({ text: clean, ...style });
  };
  let from = 0;
  for (const match of line.matchAll(ESCAPE)) {
    push(line.slice(from, match.index));
    from = match.index + match[0].length;
    if (match[2] === "m") style = apply(style, match[1] ?? "");
  }
  push(line.slice(from));
  return runs;
}
