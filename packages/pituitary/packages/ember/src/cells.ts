import { type Hearth, heatAt } from "./hearth.ts";
import { lit } from "./ramp.ts";

/**
 * How a character cell is divided into pixels, and what the cell spends them on.
 *
 * | mapping    | pixels | spent on                                              |
 * | ---------- | ------ | ----------------------------------------------------- |
 * | `shade`    | 1 × 1  | coverage: `░▒▓█`, coloured again by heat              |
 * | `solid`    | 1 × 1  | colour alone, in full blocks                          |
 * | `half`     | 1 × 2  | two stacked square pixels, each with its own colour   |
 * | `sideways` | 2 × 1  | two pixels side by side, each with its own colour     |
 * | `quadrant` | 2 × 2  | four pixels clustered into two colours                |
 * | `eighths`  | 1 × 8  | height: the lit run measured up from the cell floor   |
 * | `gauge`    | 1 × 1  | amplitude: the cell filled upward to its heat         |
 * | `taper`    | strip  | amplitude across the width: one bar spread over every |
 * |            |        | column, filled from the left edge                     |
 */
export type Mapping = "shade" | "solid" | "half" | "sideways" | "quadrant" | "eighths" | "gauge" | "taper";

export const MAPPINGS: readonly Mapping[] = [
  "shade",
  "solid",
  "half",
  "sideways",
  "quadrant",
  "eighths",
  "gauge",
  "taper",
];

/**
 * One drawn cell: a glyph, the heat its foreground glows at, and the heat of the cell
 * behind it. A `bg` of 0 leaves whatever lies behind the fire showing.
 */
export interface Cell {
  char: string;
  fg: number;
  bg: number;
}

/** Heats closer than this read as one colour, so the cell draws as a full block. */
const SAME = 0.04;

/** Pixels across and down per character cell. */
export function grain(mapping: Mapping): readonly [number, number] {
  switch (mapping) {
    case "half":
      return [1, 2];
    case "sideways":
      return [2, 1];
    case "quadrant":
      return [2, 2];
    case "eighths":
      return [1, 8];
    default:
      return [1, 1];
  }
}

/** The hearth, in pixels, that fills `cols` × `rows` cells under `mapping`. */
export function pixels(mapping: Mapping, cols: number, rows: number): readonly [number, number] {
  if (mapping === "taper") return [1, rows];
  const [across, down] = grain(mapping);
  return [cols * across, rows * down];
}

/** The fire as cells, row-major, `null` where nothing is lit. */
export function paint(hearth: Hearth, mapping: Mapping, cols: number, rows: number): (Cell | null)[] {
  const out: (Cell | null)[] = new Array(cols * rows).fill(null);
  const at = (x: number, y: number) => heatAt(hearth, x, y);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out[row * cols + col] = cellOf(mapping, at, col, row, cols);
    }
  }
  return out;
}

type HeatAt = (x: number, y: number) => number;

const SHADES = ["░", "▒", "▓", "█"] as const;
const RISE = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const WIDTH = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

/** Quadrant glyphs by mask: top-left 1, top-right 2, bottom-left 4, bottom-right 8. */
const QUADRANTS = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"] as const;

function cellOf(mapping: Mapping, at: HeatAt, col: number, row: number, cols: number): Cell | null {
  switch (mapping) {
    case "shade": {
      const heat = at(col, row);
      if (!lit(heat)) return null;
      const shade = heat < 0.3 ? 0 : heat < 0.55 ? 1 : heat < 0.8 ? 2 : 3;
      return { char: SHADES[shade], fg: heat, bg: 0 };
    }
    case "solid": {
      const heat = at(col, row);
      return lit(heat) ? { char: "█", fg: heat, bg: 0 } : null;
    }
    case "half":
      return pair(at(col, row * 2), at(col, row * 2 + 1), "▀", "▄");
    case "sideways":
      return pair(at(col * 2, row), at(col * 2 + 1, row), "▌", "▐");
    case "quadrant":
      return quadrant([
        at(col * 2, row * 2),
        at(col * 2 + 1, row * 2),
        at(col * 2, row * 2 + 1),
        at(col * 2 + 1, row * 2 + 1),
      ]);
    case "eighths": {
      let run = 0;
      let sum = 0;
      for (let step = 7; step >= 0; step--) {
        const heat = at(col, row * 8 + step);
        if (!lit(heat)) break;
        run++;
        sum += heat;
      }
      return run === 0 ? null : { char: RISE[run] ?? "█", fg: sum / run, bg: 0 };
    }
    case "gauge": {
      const heat = at(col, row);
      const fill = Math.min(8, Math.round(heat * 8));
      return !lit(heat) || fill === 0 ? null : { char: RISE[fill] ?? "█", fg: heat, bg: 0 };
    }
    case "taper": {
      const heat = at(0, row);
      const fill = Math.min(8, Math.max(0, Math.round(heat * cols * 8) - col * 8));
      return !lit(heat) || fill === 0 ? null : { char: WIDTH[fill] ?? "█", fg: heat, bg: 0 };
    }
  }
}

/** A cell split in two: `first` is drawn as the glyph, `second` as the cell behind it. */
function pair(first: number, second: number, firstGlyph: string, secondGlyph: string): Cell | null {
  const a = lit(first);
  const b = lit(second);
  if (!a && !b) return null;
  if (!a) return { char: secondGlyph, fg: second, bg: 0 };
  if (!b) return { char: firstGlyph, fg: first, bg: 0 };
  if (Math.abs(first - second) < SAME) return { char: "█", fg: (first + second) / 2, bg: 0 };
  return { char: firstGlyph, fg: first, bg: second };
}

/**
 * Four pixels in one cell, which carries one foreground and one background.
 *
 * With any pixel unlit the background must stay clear, so the lit ones share one
 * colour. With all four lit they split at their own midpoint into a hot and a cool
 * side, each drawn at its mean.
 */
function quadrant(heats: readonly [number, number, number, number]): Cell | null {
  let mask = 0;
  let litSum = 0;
  let count = 0;
  heats.forEach((heat, index) => {
    if (!lit(heat)) return;
    mask |= 1 << index;
    litSum += heat;
    count++;
  });
  if (count === 0) return null;
  if (count < 4) return { char: QUADRANTS[mask] ?? "█", fg: litSum / count, bg: 0 };

  const middle = (Math.min(...heats) + Math.max(...heats)) / 2;
  let hotMask = 0;
  let hot = 0;
  let hotSum = 0;
  let coolSum = 0;
  heats.forEach((heat, index) => {
    if (heat > middle) {
      hotMask |= 1 << index;
      hot++;
      hotSum += heat;
    } else coolSum += heat;
  });
  const fg = hot === 0 ? coolSum / 4 : hotSum / hot;
  const bg = hot === 4 || hot === 0 ? fg : coolSum / (4 - hot);
  if (Math.abs(fg - bg) < SAME || hotMask === 0) return { char: "█", fg: (fg + bg) / 2, bg: 0 };
  return { char: QUADRANTS[hotMask] ?? "█", fg, bg };
}
