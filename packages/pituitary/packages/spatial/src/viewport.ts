import { type Cells, type Coord, type Extent, spanOf } from "./coord.ts";
import { FAR, NEAR } from "./zoom.ts";

/**
 * Cells the focused pane gives up per axis, which its neighbours show through.
 *
 * This is the whole adjacency cue: the freed cells fall on the sides that have a
 * neighbour, so what lies each way is legible without a map. Centred between two
 * neighbours the cells split between them; against a wall the whole peek falls
 * inward. Zero peeks nothing.
 */
export type Peek = Cells;

export const NO_PEEK: Peek = [0, 0];

/** Smallest pane worth drawing, so a wide lattice cannot shrink panes to nothing. */
export const FLOOR: Cells = [8, 3];

/**
 * Cells a pane occupies at a given scale.
 *
 * Close in, a pane is the viewport less the peek. Far out, every pane fits at once.
 */
export function strideAt(within: Extent, viewport: Cells, scale: number, peek: Peek = NO_PEEK): Cells {
  const held = Math.min(NEAR, Math.max(FAR, scale));
  const span = spanOf(within);
  return [
    strideOn(viewport[0], span[0], held, peek[0], FLOOR[0]),
    strideOn(viewport[1], span[1], held, peek[1], FLOOR[1]),
  ];
}

/**
 * The surface origin in cells that centres a lattice position, held inside the
 * region.
 *
 * Cells rather than lattice fractions: a fractional origin rounds differently per
 * pane and clips an edge by a row. A region smaller than the viewport has no room to
 * slide and is centred in it.
 */
export function originFor(within: Extent, stride: Cells, on: Coord, viewport: Cells): Cells {
  const { min, max } = within;
  return [
    hold(centre(on[0], stride[0], viewport[0]), min[0] * stride[0], (max[0] + 1) * stride[0] - viewport[0]),
    hold(centre(on[1], stride[1], viewport[1]), min[1] * stride[1], (max[1] + 1) * stride[1] - viewport[1]),
  ];
}

/** Where a pane's top-left corner falls on screen, given the surface origin. */
export function offsetOf(at: Coord, stride: Cells, origin: Cells): Cells {
  return [at[0] * stride[0] - origin[0], at[1] * stride[1] - origin[1]];
}

/** Whether a pane at this offset contributes anything to the frame. */
export function onScreen(offset: Cells, stride: Cells, viewport: Cells): boolean {
  return (
    offset[0] < viewport[0] && offset[1] < viewport[1] && offset[0] > -stride[0] && offset[1] > -stride[1]
  );
}

function strideOn(viewport: number, span: number, scale: number, peek: number, floor: number): number {
  // An axis the region does not extend along has nothing to peek at, so it keeps
  // the whole viewport however wide the peek is.
  const near = viewport - (span > 1 ? peek : 0);
  const far = Math.floor(viewport / span);
  return Math.max(floor, Math.round(far + (near - far) * scale));
}

function centre(on: number, stride: number, viewport: number): number {
  return Math.round((on + 0.5) * stride - viewport / 2);
}

function hold(value: number, low: number, high: number): number {
  // No room to slide: centre the region rather than pinning it to one edge.
  return high < low ? Math.round((low + high) / 2) : Math.min(high, Math.max(low, value));
}
