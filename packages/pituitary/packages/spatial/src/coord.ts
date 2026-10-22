/** A position on the lattice, in lattice cells. */
export type Coord = readonly [x: number, y: number];

/** A width and a height in terminal cells. */
export type Cells = readonly [columns: number, rows: number];

/** The region a set of positions occupies, inclusive of both corners. */
export interface Extent {
  min: Coord;
  max: Coord;
}

/** The four ways out of a position. */
export type Heading = "north" | "east" | "south" | "west";

export const HEADINGS: readonly Heading[] = ["north", "east", "south", "west"];

/** North is toward the top of the screen, so it decreases y. */
const STEP: Record<Heading, Coord> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

export const OPPOSITE: Record<Heading, Heading> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

export function step(from: Coord, heading: Heading): Coord {
  const [dx, dy] = STEP[heading];
  return [from[0] + dx, from[1] + dy];
}

export function same(a: Coord, b: Coord): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** The heading from one position toward another, along whichever axis differs most. */
export function bearing(from: Coord, to: Coord): Heading | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "east" : "west";
  return dy > 0 ? "south" : "north";
}

/** The region covering every position given. */
export function extentOf(positions: readonly Coord[]): Extent {
  const xs = positions.map((at) => at[0]);
  const ys = positions.map((at) => at[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

/** Lattice cells a region occupies, which sets how far a surface can widen. */
export function spanOf(within: Extent): Cells {
  return [within.max[0] - within.min[0] + 1, within.max[1] - within.min[1] + 1];
}
