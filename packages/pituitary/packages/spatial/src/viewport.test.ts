import { describe, expect, test } from "bun:test";
import type { Cells, Coord, Extent } from "./coord.ts";
import { NO_PEEK, offsetOf, onScreen, originFor, strideAt } from "./viewport.ts";
import { FAR, NEAR } from "./zoom.ts";

/** A region `wide` by `high`, its north-west corner at `from`. */
function grid(wide: number, high: number, from: Coord = [0, 0]): Extent {
  return { min: from, max: [from[0] + wide - 1, from[1] + high - 1] };
}

/** Every position a region covers, north row first. */
function positions(within: Extent): Coord[] {
  const out: Coord[] = [];
  for (let y = within.min[1]; y <= within.max[1]; y++) {
    for (let x = within.min[0]; x <= within.max[0]; x++) out.push([x, y]);
  }
  return out;
}

/** Three cells west to east with one above the first: span [3, 2]. */
const space: Extent = { min: [0, -1], max: [2, 0] };
const row = grid(3, 1);
const lone = grid(1, 1);

describe("stride", () => {
  test("at its closest a pane is the viewport less the peek", () => {
    expect(strideAt(space, [100, 30], NEAR, [6, 2])).toEqual([94, 28]);
  });

  test("with no peek a pane fills the viewport at its closest", () => {
    expect(strideAt(space, [100, 30], NEAR, NO_PEEK)).toEqual([100, 30]);
    expect(strideAt(space, [100, 30], NEAR)).toEqual([100, 30]);
  });

  test("at its widest every pane fits at once", () => {
    const stride = strideAt(space, [100, 30], FAR, [6, 2]);
    expect(stride).toEqual([33, 15]);
    expect(stride[0] * 3).toBeLessThanOrEqual(100);
    expect(stride[1] * 2).toBeLessThanOrEqual(30);
  });

  test("the widest stride ignores the peek", () => {
    expect(strideAt(space, [100, 30], FAR, [6, 2])).toEqual(strideAt(space, [100, 30], FAR, NO_PEEK));
  });

  test("between the two the stride crosses from one to the other", () => {
    expect(strideAt(space, [100, 30], 0.5, [6, 2])).toEqual([64, 22]);
    expect(strideAt(space, [100, 30], 0.25, [6, 2])).toEqual([48, 18]);
  });

  test("a scale beyond the two ends is held at the end it passed", () => {
    expect(strideAt(space, [100, 30], 5, [6, 2])).toEqual(strideAt(space, [100, 30], NEAR, [6, 2]));
    expect(strideAt(space, [100, 30], -3, [6, 2])).toEqual(strideAt(space, [100, 30], FAR, [6, 2]));
  });

  test("the stride is whole cells at every scale", () => {
    for (let scale = 0; scale <= 1.0001; scale += 0.05) {
      const stride = strideAt(space, [100, 30], scale, [6, 2]);
      expect(Number.isInteger(stride[0])).toBe(true);
      expect(Number.isInteger(stride[1])).toBe(true);
    }
  });

  test("panes grow as the surface closes in", () => {
    let previous = strideAt(space, [100, 30], FAR, [6, 2]);
    for (let scale = 0.05; scale <= 1.0001; scale += 0.05) {
      const stride = strideAt(space, [100, 30], scale, [6, 2]);
      expect(stride[0]).toBeGreaterThanOrEqual(previous[0]);
      expect(stride[1]).toBeGreaterThanOrEqual(previous[1]);
      previous = stride;
    }
    expect(previous).toEqual([94, 28]);
  });

  test("the floor keeps panes drawable when the lattice outgrows the viewport", () => {
    const sprawl = grid(20, 20);
    expect(strideAt(sprawl, [100, 30], FAR)).toEqual([8, 3]);
    expect(strideAt(sprawl, [100, 30], 0.2)).toEqual([24, 7]);
  });

  test("a viewport narrower than the floor still gets the floor", () => {
    expect(strideAt(space, [4, 2], NEAR)).toEqual([8, 3]);
    expect(strideAt(space, [4, 2], FAR)).toEqual([8, 3]);
  });

  test("a peek wider than the viewport falls back to the floor", () => {
    expect(strideAt(space, [100, 30], NEAR, [200, 200])).toEqual([8, 3]);
    expect(strideAt(space, [100, 30], NEAR, [100, 30])).toEqual([8, 3]);
  });

  test("a lone pane has the viewport to itself at its widest", () => {
    expect(strideAt(lone, [100, 30], FAR, [6, 2])).toEqual([100, 30]);
  });

  test("an axis the lattice does not extend along keeps its whole viewport", () => {
    // A single row has nothing above or below to reveal, so the y peek costs it
    // nothing however wide it is asked for.
    expect(strideAt(row, [100, 30], NEAR, [6, 2])).toEqual([94, 30]);
    expect(strideAt(row, [100, 30], FAR, [6, 2])).toEqual([33, 30]);
    expect(strideAt(lone, [100, 30], NEAR, [6, 2])).toEqual([100, 30]);
    expect(strideAt(lone, [100, 30], NEAR, [200, 200])).toEqual([100, 30]);
  });
});

describe("the surface origin", () => {
  const viewport: Cells = [100, 28];
  const stride: Cells = [20, 8];
  const wide = grid(10, 5);

  test("centring puts the pane under the middle of the viewport", () => {
    expect(originFor(wide, stride, [4, 2], viewport)).toEqual([40, 6]);
    expect(originFor(wide, stride, [5, 2], viewport)).toEqual([60, 6]);
  });

  test("the origin never passes the western wall", () => {
    expect(originFor(wide, stride, [0, 2], viewport)[0]).toBe(0);
    expect(originFor(wide, stride, [1, 2], viewport)[0]).toBe(0);
  });

  test("the origin never passes the eastern wall", () => {
    expect(originFor(wide, stride, [9, 2], viewport)[0]).toBe(10 * 20 - 100);
    expect(originFor(wide, stride, [8, 2], viewport)[0]).toBe(10 * 20 - 100);
  });

  test("the origin never passes the northern wall", () => {
    expect(originFor(wide, stride, [4, 0], viewport)[1]).toBe(0);
    expect(originFor(wide, stride, [4, 1], viewport)[1]).toBe(0);
  });

  test("the origin never passes the southern wall", () => {
    expect(originFor(wide, stride, [4, 4], viewport)[1]).toBe(5 * 8 - 28);
    expect(originFor(wide, stride, [4, 3], viewport)[1]).toBe(5 * 8 - 28);
  });

  test("the walls are the lattice's own edges, wherever they lie", () => {
    const away = grid(10, 5, [-12, -9]);
    expect(originFor(away, stride, [-12, -9], viewport)).toEqual([-12 * 20, -9 * 8]);
    expect(originFor(away, stride, [-3, -5], viewport)).toEqual([-2 * 20 - 100, -4 * 8 - 28]);
  });

  test("a lattice smaller than the viewport is centred, not pinned", () => {
    const small = grid(3, 2);
    // Three columns of 20 cells in a 100-cell viewport leaves 40 to split.
    expect(originFor(small, stride, [0, 0], viewport)).toEqual([-20, -6]);
    expect(originFor(small, stride, [2, 1], viewport)).toEqual([-20, -6]);
  });

  test("a lattice with no room to slide holds one origin whatever pane is asked for", () => {
    const small = grid(3, 2, [-4, -3]);
    const held = originFor(small, stride, [-4, -3], viewport);
    for (const at of positions(small)) {
      expect(originFor(small, stride, at, viewport)).toEqual(held);
    }
  });

  test("a lattice exactly filling the viewport pins to its corner", () => {
    const exact = grid(5, 3);
    expect(originFor(exact, [20, 9], [0, 0], [100, 27])).toEqual([0, 0]);
    expect(originFor(exact, [20, 9], [4, 2], [100, 27])).toEqual([0, 0]);
  });

  test("an axis with room to slide is held while the other is centred", () => {
    const tall = grid(2, 10);
    const origin = originFor(tall, stride, [1, 9], viewport);
    expect(origin[0]).toBe(-30);
    expect(origin[1]).toBe(10 * 8 - 28);
  });

  test("the origin is whole cells", () => {
    for (const at of positions(wide)) {
      const origin = originFor(wide, [19, 7], at, [101, 29]);
      expect(Number.isInteger(origin[0])).toBe(true);
      expect(Number.isInteger(origin[1])).toBe(true);
    }
  });

  test("the origin tracks a fractional position between panes", () => {
    const held = originFor(wide, stride, [4, 2], viewport);
    const part = originFor(wide, stride, [4.5, 2], viewport);
    const next = originFor(wide, stride, [5, 2], viewport);
    expect(part[0]).toBeGreaterThan(held[0]);
    expect(part[0]).toBeLessThan(next[0]);
  });
});

describe("what lands on screen", () => {
  const viewport: Cells = [100, 28];
  const stride: Cells = [20, 8];

  test("a pane's offset is its position in cells less the origin", () => {
    expect(offsetOf([2, 1], stride, [10, 4])).toEqual([30, 4]);
    expect(offsetOf([0, 0], stride, [0, 0])).toEqual([0, 0]);
    expect(offsetOf([-1, -2], stride, [0, 0])).toEqual([-20, -16]);
    expect(offsetOf([-1, -2], stride, [-40, -24])).toEqual([20, 8]);
  });

  test("a pane at the top-left corner is on screen", () => {
    expect(onScreen([0, 0], stride, viewport)).toBe(true);
  });

  test("a pane with one cell inside the eastern edge is on screen", () => {
    expect(onScreen([99, 0], stride, viewport)).toBe(true);
    expect(onScreen([100, 0], stride, viewport)).toBe(false);
    expect(onScreen([101, 0], stride, viewport)).toBe(false);
  });

  test("a pane with one cell inside the western edge is on screen", () => {
    expect(onScreen([-19, 0], stride, viewport)).toBe(true);
    expect(onScreen([-20, 0], stride, viewport)).toBe(false);
    expect(onScreen([-21, 0], stride, viewport)).toBe(false);
  });

  test("a pane with one cell inside the southern edge is on screen", () => {
    expect(onScreen([0, 27], stride, viewport)).toBe(true);
    expect(onScreen([0, 28], stride, viewport)).toBe(false);
  });

  test("a pane with one cell inside the northern edge is on screen", () => {
    expect(onScreen([0, -7], stride, viewport)).toBe(true);
    expect(onScreen([0, -8], stride, viewport)).toBe(false);
  });

  test("a pane off screen on one axis is off screen", () => {
    expect(onScreen([0, 28], stride, viewport)).toBe(false);
    expect(onScreen([100, 0], stride, viewport)).toBe(false);
    expect(onScreen([-20, 27], stride, viewport)).toBe(false);
  });

  test("a pane larger than the viewport still covers it", () => {
    expect(onScreen([-150, -40], [200, 50], viewport)).toBe(true);
    expect(onScreen([-200, 0], [200, 50], viewport)).toBe(false);
  });

  test("at its closest with no peek only the focused pane is on screen", () => {
    const stride = strideAt(row, [100, 30], NEAR, NO_PEEK);
    const origin = originFor(row, stride, [1, 0], [100, 30]);
    const seen = positions(row).filter((at) => onScreen(offsetOf(at, stride, origin), stride, [100, 30]));
    expect(seen).toEqual([[1, 0]]);
  });

  test("the peek leaves the neighbouring panes on screen, split between the two sides", () => {
    const stride = strideAt(row, [100, 30], NEAR, [6, 0]);
    const origin = originFor(row, stride, [1, 0], [100, 30]);
    const west = offsetOf([0, 0], stride, origin);
    const focused = offsetOf([1, 0], stride, origin);
    const east = offsetOf([2, 0], stride, origin);
    expect([west, focused, east]).toEqual([
      [-91, 0],
      [3, 0],
      [97, 0],
    ]);
    for (const offset of [west, focused, east]) {
      expect(onScreen(offset, stride, [100, 30])).toBe(true);
    }
    // Three cells of the western pane, three of the eastern: the peek, split.
    expect(west[0] + stride[0]).toBe(3);
    expect(100 - east[0]).toBe(3);
  });

  test("at the wall the peek falls on the side that has a neighbour", () => {
    const stride = strideAt(row, [100, 30], NEAR, [6, 0]);
    const origin = originFor(row, stride, [0, 0], [100, 30]);
    expect(origin[0]).toBe(0);
    const seen = positions(row).filter((at) => onScreen(offsetOf(at, stride, origin), stride, [100, 30]));
    expect(seen).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(offsetOf([1, 0], stride, origin)).toEqual([94, 0]);
  });

  test("at its widest every pane is on screen at once", () => {
    const viewport: Cells = [100, 30];
    const stride = strideAt(space, viewport, FAR, [6, 2]);
    const origin = originFor(space, stride, [1, 0], viewport);
    for (const at of positions(space)) {
      expect(onScreen(offsetOf(at, stride, origin), stride, viewport)).toBe(true);
    }
  });
});
