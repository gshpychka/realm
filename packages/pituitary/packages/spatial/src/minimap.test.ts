import { describe, expect, test } from "bun:test";
import type { Coord } from "./coord.ts";
import { lattice, type Placed } from "./lattice.ts";
import { minimapSize } from "./minimap.tsx";

function placed(id: string, at: Coord): Placed {
  return { id, at };
}

describe("the cells a minimap occupies", () => {
  test("a lone pane is one cell", () => {
    expect(minimapSize(lattice([placed("only", [0, 0])]))).toEqual([1, 1]);
  });

  test("a row is as wide as the row and one row high", () => {
    expect(minimapSize(lattice([placed("a", [0, 0]), placed("b", [1, 0]), placed("c", [2, 0])]))).toEqual([
      3, 1,
    ]);
  });

  test("the blanks count, because the shape is what carries the reading", () => {
    // Two panes four columns apart occupy every column between them.
    expect(minimapSize(lattice([placed("a", [0, 0]), placed("b", [4, 0])]))).toEqual([5, 1]);
  });

  test("a lattice running negative is measured from its own corner", () => {
    const sparse = lattice([placed("a", [-3, -2]), placed("b", [0, 0]), placed("c", [1, 1])]);
    expect(minimapSize(sparse)).toEqual([5, 4]);
  });

  test("a cross is three by three, holes and all", () => {
    const cross = lattice([
      placed("hub", [0, 0]),
      placed("up", [0, -1]),
      placed("down", [0, 1]),
      placed("left", [-1, 0]),
      placed("right", [1, 0]),
    ]);
    expect(minimapSize(cross)).toEqual([3, 3]);
  });
});
