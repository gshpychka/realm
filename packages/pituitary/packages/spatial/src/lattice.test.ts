import { describe, expect, test } from "bun:test";
import type { Coord } from "./coord.ts";
import type { Lattice, Pane } from "./lattice.ts";
import { exits, extent, lattice, neighbour, paneAt, paneById, rows, span, towards } from "./lattice.ts";

function pane(id: string, at: Coord): Pane {
  return { id, at, name: id, render: () => null };
}

function of(space: Lattice, id: string): Pane {
  const found = paneById(space, id);
  if (!found) throw new Error(`no pane "${id}"`);
  return found;
}

/** Pane ids per lattice row, which is the whole of what `rows` orders. */
function rowIds(space: Lattice): string[][] {
  return rows(space).map((row) => row.map((each) => each.id));
}

const space = lattice([
  pane("talk", [0, 0]),
  pane("code", [1, 0]),
  pane("diff", [2, 0]),
  pane("past", [0, -1]),
]);

describe("lattice", () => {
  test("panes are found by id and by position", () => {
    expect(of(space, "code").name).toBe("code");
    expect(paneAt(space, [2, 0])?.id).toBe("diff");
    expect(paneAt(space, [0, -1])?.id).toBe("past");
  });

  test("an empty position holds no pane", () => {
    expect(paneAt(space, [9, 9])).toBeUndefined();
    expect(paneAt(space, [1, -1])).toBeUndefined();
    expect(paneById(space, "absent")).toBeUndefined();
  });

  test("a neighbour is one step away, when something is there", () => {
    const talk = of(space, "talk");
    expect(neighbour(space, talk, "east")?.id).toBe("code");
    expect(neighbour(space, talk, "north")?.id).toBe("past");
    expect(neighbour(space, talk, "west")).toBeUndefined();
    expect(neighbour(space, talk, "south")).toBeUndefined();
  });

  test("adjacency reads the same from both sides", () => {
    const talk = of(space, "talk");
    const code = of(space, "code");
    expect(neighbour(space, talk, "east")?.id).toBe(code.id);
    expect(neighbour(space, code, "west")?.id).toBe(talk.id);
  });

  test("exits are the headings that lead somewhere", () => {
    expect([...exits(space, of(space, "talk"))]).toEqual(["north", "east"]);
    expect([...exits(space, of(space, "diff"))]).toEqual(["west"]);
    expect([...exits(space, of(space, "past"))]).toEqual(["south"]);
  });

  test("a lone pane has no exits", () => {
    const alone = lattice([pane("only", [3, -2])]);
    expect([...exits(alone, of(alone, "only"))]).toEqual([]);
  });

  test("a gap in the lattice is not an exit", () => {
    const gapped = lattice([pane("west", [0, 0]), pane("east", [2, 0])]);
    expect([...exits(gapped, of(gapped, "west"))]).toEqual([]);
    expect(neighbour(gapped, of(gapped, "west"), "east")).toBeUndefined();
  });

  test("towards points from one pane to another", () => {
    expect(towards(of(space, "diff"), of(space, "past"))).toBe("west");
    expect(towards(of(space, "past"), of(space, "talk"))).toBe("south");
    expect(towards(of(space, "diff"), of(space, "diff"))).toBeNull();
  });

  test("extent spans every pane, including negative positions", () => {
    expect(extent(space)).toEqual({ min: [0, -1], max: [2, 0] });
    const sparse = lattice([pane("a", [-4, 6]), pane("b", [2, -3]), pane("c", [0, 0])]);
    expect(extent(sparse)).toEqual({ min: [-4, -3], max: [2, 6] });
  });

  test("a span counts the cells between panes as well as the panes", () => {
    expect(span(space)).toEqual([3, 2]);
    expect(span(lattice([pane("a", [0, 0]), pane("b", [5, 0])]))).toEqual([6, 1]);
    expect(span(lattice([pane("a", [-3, -3]), pane("b", [-1, -2])]))).toEqual([3, 2]);
  });

  test("a lone pane spans one cell", () => {
    expect(span(lattice([pane("only", [7, -9])]))).toEqual([1, 1]);
    expect(extent(lattice([pane("only", [7, -9])]))).toEqual({ min: [7, -9], max: [7, -9] });
  });

  test("a single row spans one cell high, a single column one cell wide", () => {
    expect(span(lattice([pane("a", [0, 0]), pane("b", [1, 0]), pane("c", [2, 0])]))).toEqual([3, 1]);
    expect(span(lattice([pane("a", [0, 0]), pane("b", [0, 1]), pane("c", [0, 2])]))).toEqual([1, 3]);
  });

  test("rows group panes into their lattice rows, north first", () => {
    expect(rowIds(space)).toEqual([["past"], ["talk", "code", "diff"]]);
  });

  test("rows run west to east whatever order the panes were given in", () => {
    const jumbled = lattice([pane("c", [2, 0]), pane("a", [0, 0]), pane("d", [3, 0]), pane("b", [1, 0])]);
    expect(rowIds(jumbled)).toEqual([["a", "b", "c", "d"]]);
  });

  test("rows sort by lattice row across negative and non-contiguous rows", () => {
    const scattered = lattice([
      pane("low", [0, 5]),
      pane("high", [0, -4]),
      pane("mid", [1, 0]),
      pane("high-east", [1, -4]),
    ]);
    expect(rowIds(scattered)).toEqual([["high", "high-east"], ["mid"], ["low"]]);
  });

  test("an empty lattice row is left out rather than drawn as a blank", () => {
    const stacked = lattice([pane("a", [0, 0]), pane("b", [0, 3])]);
    expect(rows(stacked)).toHaveLength(2);
    expect(span(stacked)).toEqual([1, 4]);
  });

  test("every pane appears in exactly one row", () => {
    const flattened = rows(space).flat();
    expect(flattened).toHaveLength(space.panes.length);
    expect(new Set(flattened.map((each) => each.id)).size).toBe(space.panes.length);
  });

  test("a lattice needs at least one pane", () => {
    expect(() => lattice([])).toThrow("a lattice needs at least one pane");
  });

  test("two panes cannot share an id", () => {
    expect(() => lattice([pane("talk", [0, 0]), pane("talk", [1, 0])])).toThrow('duplicate pane id "talk"');
  });

  test("two panes cannot share a position", () => {
    expect(() => lattice([pane("talk", [1, -2]), pane("code", [1, -2])])).toThrow(
      'panes "talk" and "code" share position 1,-2',
    );
  });

  test("a lattice holds the panes it was given", () => {
    const panes = [pane("a", [0, 0]), pane("b", [1, 0])];
    expect(lattice(panes).panes).toEqual(panes);
  });

  test("sparse and negative positions make a lattice", () => {
    const far = lattice([pane("a", [-9, -9]), pane("b", [9, 9])]);
    expect(far.panes).toHaveLength(2);
    expect(paneAt(far, [-9, -9])?.id).toBe("a");
  });
});

describe("a lattice holds its own panes", () => {
  test("custom pane objects retain their rendering behavior", () => {
    class Tile {
      id = "talk";
      at: Coord = [0, 0];
      #caption = "conversation";
      render() {
        return this.#caption;
      }
    }
    const held = lattice([new Tile()]);
    expect(held.panes[0]?.render()).toBe("conversation");
  });

  test("ids must name a pane and positions must be finite lattice cells", () => {
    expect(() => lattice([pane("", [0, 0])])).toThrow("pane id");
    for (const coordinate of [0.5, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      expect(() => lattice([pane("invalid", [coordinate, 0])])).toThrow("integer");
    }
  });

  test("mutating the array it was built from cannot slip a pane past the checks", () => {
    const panes = [pane("talk", [0, 0]), pane("code", [1, 0])];
    const held = lattice(panes);
    panes.push(pane("talk", [0, 0]));
    expect(held.panes).toHaveLength(2);
    expect(held.panes.map((each) => each.id)).toEqual(["talk", "code"]);
  });
});
