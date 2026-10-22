import { describe, expect, test } from "bun:test";
import type { Coord } from "./coord.ts";
import { bearing, extentOf, HEADINGS, OPPOSITE, same, spanOf, step } from "./coord.ts";

describe("coord", () => {
  test("north is toward the top of the screen", () => {
    expect(step([0, 0], "north")).toEqual([0, -1]);
    expect(step([0, 0], "south")).toEqual([0, 1]);
    expect(step([0, 0], "east")).toEqual([1, 0]);
    expect(step([0, 0], "west")).toEqual([-1, 0]);
  });

  test("there are four ways out and each has an opposite", () => {
    expect([...HEADINGS].sort()).toEqual(["east", "north", "south", "west"]);
    for (const heading of HEADINGS) {
      expect(OPPOSITE[OPPOSITE[heading]]).toBe(heading);
      expect(OPPOSITE[heading]).not.toBe(heading);
    }
  });

  test("stepping a heading then its opposite returns", () => {
    for (const heading of HEADINGS) {
      expect(step(step([3, 2], heading), OPPOSITE[heading])).toEqual([3, 2]);
      expect(step(step([-7, -4], heading), OPPOSITE[heading])).toEqual([-7, -4]);
    }
  });

  test("stepping leaves the position it was given alone", () => {
    const from: Coord = [1, 1];
    const to = step(from, "south");
    expect(from).toEqual([1, 1]);
    expect(to).not.toBe(from);
  });

  test("same compares positions by value", () => {
    expect(same([1, 2], [1, 2])).toBe(true);
    expect(same([1, 2], [2, 1])).toBe(false);
    expect(same([-3, -3], [-3, -3])).toBe(true);
    expect(same([0, 0], [0, -1])).toBe(false);
  });

  test("a bearing follows the axis that differs most", () => {
    expect(bearing([0, 0], [3, 1])).toBe("east");
    expect(bearing([0, 0], [-1, 4])).toBe("south");
    expect(bearing([0, 0], [0, -2])).toBe("north");
    expect(bearing([2, 0], [0, 0])).toBe("west");
  });

  test("a bearing across equal distances follows the horizontal axis", () => {
    expect(bearing([0, 0], [1, 1])).toBe("east");
    expect(bearing([0, 0], [1, -1])).toBe("east");
    expect(bearing([0, 0], [-1, 1])).toBe("west");
    expect(bearing([0, 0], [-1, -1])).toBe("west");
  });

  test("a bearing over a single step is that step's heading", () => {
    const from: Coord = [4, -2];
    for (const heading of HEADINGS) {
      expect(bearing(from, step(from, heading))).toBe(heading);
    }
  });

  test("a bearing to the same place is no heading at all", () => {
    expect(bearing([2, 2], [2, 2])).toBeNull();
    expect(bearing([-5, 9], [-5, 9])).toBeNull();
  });

  test("a bearing back is the opposite of the bearing out", () => {
    const pairs: [Coord, Coord][] = [
      [
        [0, 0],
        [3, 1],
      ],
      [
        [0, 0],
        [1, 1],
      ],
      [
        [-2, 5],
        [-2, -4],
      ],
      [
        [7, 7],
        [6, 9],
      ],
    ];
    for (const [from, to] of pairs) {
      const out = bearing(from, to);
      if (out === null) throw new Error("expected a heading");
      expect(bearing(to, from)).toBe(OPPOSITE[out]);
    }
  });
});

describe("regions", () => {
  test("a region covers every position given", () => {
    expect(extentOf([[0, 0]])).toEqual({ min: [0, 0], max: [0, 0] });
    expect(
      extentOf([
        [2, -1],
        [-3, 4],
        [0, 0],
      ]),
    ).toEqual({ min: [-3, -1], max: [2, 4] });
  });

  test("the corners of a region are inside it, so a span counts both", () => {
    expect(spanOf({ min: [0, 0], max: [0, 0] })).toEqual([1, 1]);
    expect(spanOf({ min: [0, 0], max: [3, 2] })).toEqual([4, 3]);
    expect(spanOf({ min: [-2, -2], max: [1, 1] })).toEqual([4, 4]);
  });

  test("a region taken from positions spans what those positions reach", () => {
    const positions: Coord[] = [
      [1, -1],
      [1, 1],
      [-1, 0],
      [2, 0],
    ];
    expect(spanOf(extentOf(positions))).toEqual([4, 3]);
  });
});
