import { describe, expect, test } from "bun:test";
import type { Coord } from "./coord.ts";
import type { Passage } from "./passage.ts";
import { advance, arrived, depart, position, resting } from "./passage.ts";

/** Advances until arrival, returning the passage and the steps it took. */
function travel(from: Passage): { passage: Passage; steps: number } {
  let passage = from;
  let steps = 0;
  while (!arrived(passage)) {
    passage = advance(passage);
    if (++steps > 200) throw new Error("the passage did not arrive");
  }
  return { passage, steps };
}

describe("passage", () => {
  test("resting sits on its position and has arrived", () => {
    const held = resting([2, -1]);
    expect(position(held)).toEqual([2, -1]);
    expect(arrived(held)).toBe(true);
    expect(held.progress).toBe(1);
  });

  test("departing starts where the surface currently is", () => {
    const leaving = depart(resting([1, 0]), [3, 0]);
    expect(position(leaving)).toEqual([1, 0]);
    expect(leaving.to).toEqual([3, 0]);
    expect(leaving.progress).toBe(0);
    expect(arrived(leaving)).toBe(false);
  });

  test("departing leaves the passage it was given alone", () => {
    const held = resting([1, 1]);
    depart(held, [4, 4]);
    expect(held.to).toEqual([1, 1]);
    expect(held.progress).toBe(1);
  });

  test("easing approaches the destination and never passes it", () => {
    let passage = depart(resting([0, 0]), [1, 0]);
    let previous = 0;
    let steps = 0;
    while (!arrived(passage)) {
      passage = advance(passage);
      const [x] = position(passage);
      expect(x).toBeGreaterThan(previous);
      expect(x).toBeLessThanOrEqual(1);
      previous = x;
      if (++steps > 200) throw new Error("the passage did not arrive");
    }
    expect(position(passage)).toEqual([1, 0]);
    expect(steps).toBe(14);
  });

  test("arrival puts the surface exactly on the destination", () => {
    const { passage } = travel(depart(resting([0, 0]), [3, -7]));
    expect(passage.progress).toBe(1);
    expect(position(passage)).toEqual([3, -7]);
  });

  test("progress never passes one", () => {
    let passage = depart(resting([0, 0]), [2, 2]);
    for (let step = 0; step < 40; step++) {
      passage = advance(passage);
      expect(passage.progress).toBeLessThanOrEqual(1);
      expect(passage.progress).toBeGreaterThanOrEqual(0);
    }
  });

  test("both axes cross together and arrive at once", () => {
    let passage = depart(resting([0, 0]), [1, 1]);
    for (let step = 0; step < 6; step++) {
      passage = advance(passage);
      const [x, y] = position(passage);
      expect(x).toBe(y);
    }
    expect(position(travel(passage).passage)).toEqual([1, 1]);
  });

  test("a passage the long way round moves further per step than a short one", () => {
    const long = advance(depart(resting([0, 0]), [10, 0]));
    const short = advance(depart(resting([0, 0]), [1, 0]));
    expect(position(long)[0]).toBeGreaterThan(position(short)[0]);
    expect(long.progress).toBe(short.progress);
  });

  test("a passage redirected mid-flight departs from where the surface got to", () => {
    let passage = depart(resting([0, 0]), [3, 0]);
    passage = advance(advance(passage));
    const [midway] = position(passage);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(3);

    const turned = depart(passage, [0, 0]);
    expect(position(turned)[0]).toBeCloseTo(midway, 12);
    expect(turned.to).toEqual([0, 0]);
    expect(arrived(turned)).toBe(false);
    expect(position(travel(turned).passage)).toEqual([0, 0]);
  });

  test("redirecting mid-flight onto a new axis keeps the position it had", () => {
    let passage = depart(resting([0, 0]), [4, 0]);
    passage = advance(advance(advance(passage)));
    const before = position(passage);
    const turned = depart(passage, [0, 5]);
    expect(position(turned)).toEqual(before);
    expect(position(travel(turned).passage)).toEqual([0, 5]);
  });

  test("advancing an arrived passage is a fixed point", () => {
    const held = resting([1, 1]);
    expect(advance(held)).toBe(held);
    const { passage } = travel(depart(held, [2, 2]));
    expect(advance(passage)).toBe(passage);
  });

  test("departing for the position already held is already arrived", () => {
    const standing: Coord = [2, 2];
    const passage = depart(resting(standing), standing);
    expect(arrived(passage)).toBe(true);
    expect(position(passage)).toEqual(standing);
    expect(advance(passage)).toBe(passage);
  });

  test("departing mid-passage for the position under way is already arrived", () => {
    const under = advance(advance(depart(resting([0, 0]), [3, 0])));
    const held = depart(under, position(under));
    expect(arrived(held)).toBe(true);
    expect(position(held)).toEqual(position(under));
  });

  test("a passage between negative positions arrives exactly", () => {
    const { passage } = travel(depart(resting([-3, -4]), [-8, -1]));
    expect(position(passage)).toEqual([-8, -1]);
  });
});
