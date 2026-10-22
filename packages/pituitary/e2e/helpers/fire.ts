import type { TuiTest } from "@microsoft/tui-test";
import { FLAME } from "../../packages/ember/src/ramp.ts";

/** Flames rising from the cell floor, by height in eighths of a cell: the corner's hearth draws with them. */
export const RISE = [..."▁▂▃▄▅▆▇█"];

/**
 * Characters the fire draws with, besides a space coloured behind: quadrants, and flames in eighths
 * taller than the three eighths a coal it leaves behind fills, so its remains read as no fire.
 */
const BLOCKS = new Set([..."▖▗▘▙▚▛▜▝▞▟▀▄▌▐█", ...RISE.slice(3)]);

const channels = (colour: string) => [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));

/**
 * A colour the fire's heat ramp gives, on the line between two neighbouring stops to within rounding.
 * The screen around the fire answers its light in colours off that line.
 */
function fiery(colour: unknown): boolean {
  if (typeof colour !== "string" || !/^#[0-9a-f]{6}$/i.test(colour)) return false;
  const seen = channels(colour);
  return FLAME.slice(1).some((stop, index) => {
    const low = channels(FLAME[index]?.colour ?? stop.colour);
    const span = channels(stop.colour).map((high, channel) => high - (low[channel] ?? 0));
    const widest = Math.max(...span.map(Math.abs));
    const along = span.findIndex((value) => Math.abs(value) === widest);
    const t = ((seen[along] ?? 0) - (low[along] ?? 0)) / (span[along] || 1);
    if (t < 0 || t > 1) return false;
    return seen.every(
      (value, channel) => Math.abs(value - ((low[channel] ?? 0) + (span[channel] ?? 0) * t)) <= 2,
    );
  });
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Every cell the fire draws on the screen, as column and row. */
export async function fireCells(terminal: TuiTest, cols: number, rows: number): Promise<[number, number][]> {
  const cells = await terminal.cells(0, 0, cols, rows);
  const found: [number, number][] = [];
  cells.forEach((cell, index) => {
    const lit = (BLOCKS.has(cell.char) && fiery(cell.fg)) || fiery(cell.bg);
    if (lit) found.push([index % cols, Math.floor(index / cols)]);
  });
  return found;
}

/** Each flame the fire draws in eighths along `row`, as its column and its height in eighths of a cell. */
export async function flames(terminal: TuiTest, cols: number, row: number): Promise<[number, number][]> {
  const cells = await terminal.cells(0, row, cols, 1);
  const found: [number, number][] = [];
  cells.forEach((cell, column) => {
    const height = RISE.indexOf(cell.char) + 1;
    if (height > 0 && fiery(cell.fg)) found.push([column, height]);
  });
  return found;
}

/** The box holding every fire cell, or null when the screen shows no fire. */
export function bounds(cells: readonly [number, number][]): Box | null {
  if (cells.length === 0) return null;
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
