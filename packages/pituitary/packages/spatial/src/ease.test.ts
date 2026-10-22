import { describe, expect, test } from "bun:test";
import { approach, settled } from "./ease.ts";

/** Eases to the target, returning the value and the steps it took. */
function run(from: number, target: number): { value: number; steps: number } {
  let value = from;
  let steps = 0;
  while (!settled(value, target)) {
    value = approach(value, target);
    if (++steps > 200) throw new Error("the value did not settle");
  }
  return { value, steps };
}

describe("ease", () => {
  test("a step closes a fixed fraction of the remaining distance", () => {
    expect(approach(0, 1)).toBe(0.34);
    expect(approach(1, 0)).toBeCloseTo(0.66, 12);
    expect(approach(2, 6)).toBeCloseTo(3.36, 12);
  });

  test("a value on its target stays there and counts as settled", () => {
    expect(approach(0.5, 0.5)).toBe(0.5);
    expect(settled(0.5, 0.5)).toBe(true);
    expect(settled(0, 0)).toBe(true);
  });

  test("a value near its target is not yet settled", () => {
    expect(settled(0.999, 1)).toBe(false);
    expect(settled(1 - Number.EPSILON, 1)).toBe(false);
  });

  test("a value inside the snap distance lands exactly on the next step", () => {
    expect(approach(0.995, 1)).toBe(1);
    expect(approach(0.005, 0)).toBe(0);
  });

  test("easing lands exactly on the target in a bounded number of steps", () => {
    expect(run(0, 1)).toEqual({ value: 1, steps: 14 });
    expect(run(1, 0)).toEqual({ value: 0, steps: 14 });
    expect(run(-1, 1)).toEqual({ value: 1, steps: 15 });
  });

  test("easing closes the gap every step and never passes the target", () => {
    let value = 0;
    let gap = 1;
    for (let step = 0; step < 14; step++) {
      value = approach(value, 1);
      expect(value).toBeLessThanOrEqual(1);
      expect(1 - value).toBeLessThan(gap);
      gap = 1 - value;
    }
    expect(value).toBe(1);
  });

  test("easing downward closes the gap every step and never passes the target", () => {
    let value = 1;
    let gap = 1;
    for (let step = 0; step < 14; step++) {
      value = approach(value, 0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(gap);
      gap = value;
    }
    expect(value).toBe(0);
  });

  test("a negative target is reached as exactly as a positive one", () => {
    expect(run(0, -1)).toEqual({ value: -1, steps: 14 });
    expect(run(-4, -9).value).toBe(-9);
  });

  test("the snap distance is absolute, so a longer distance takes more steps", () => {
    expect(run(-4, -9).steps).toBe(18);
    expect(run(0, 100).steps).toBeGreaterThan(run(0, 1).steps);
  });

  test("easing a settled value is a fixed point", () => {
    expect(approach(3, 3)).toBe(3);
    expect(approach(approach(3, 3), 3)).toBe(3);
  });
});
