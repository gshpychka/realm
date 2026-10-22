import { describe, expect, test } from "bun:test";
import type { Zoom } from "./zoom.ts";
import { DETAIL, detailed, ease, FAR, NEAR, steady, to, toggle, zoom } from "./zoom.ts";

/** Eases to the target, returning the zoom and the steps it took. */
function settle(from: Zoom): { held: Zoom; steps: number } {
  let held = from;
  let steps = 0;
  while (!steady(held)) {
    held = ease(held);
    if (++steps > 200) throw new Error("the zoom did not settle");
  }
  return { held, steps };
}

describe("zoom", () => {
  test("a new zoom is held near and steady", () => {
    expect(zoom()).toEqual({ scale: NEAR, target: NEAR });
    expect(steady(zoom())).toBe(true);
    expect(NEAR).toBe(1);
    expect(FAR).toBe(0);
  });

  test("a zoom starts at the scale it is given", () => {
    expect(zoom(FAR)).toEqual({ scale: 0, target: 0 });
    expect(zoom(0.5)).toEqual({ scale: 0.5, target: 0.5 });
    expect(steady(zoom(0.5))).toBe(true);
  });

  test("a starting scale out of range is clamped", () => {
    expect(zoom(4)).toEqual({ scale: NEAR, target: NEAR });
    expect(zoom(-2)).toEqual({ scale: FAR, target: FAR });
  });

  test("a target out of range is clamped", () => {
    expect(to(zoom(), 4).target).toBe(NEAR);
    expect(to(zoom(), -2).target).toBe(FAR);
    expect(to(zoom(), Number.POSITIVE_INFINITY).target).toBe(NEAR);
  });

  test("a new target leaves the scale where it is", () => {
    const pulled = to(zoom(NEAR), FAR);
    expect(pulled.scale).toBe(NEAR);
    expect(pulled.target).toBe(FAR);
    expect(steady(pulled)).toBe(false);
  });

  test("toggling swaps between near and far", () => {
    expect(toggle(zoom(NEAR)).target).toBe(FAR);
    expect(toggle(zoom(FAR)).target).toBe(NEAR);
  });

  test("toggling twice asks for the scale it started from", () => {
    expect(toggle(toggle(zoom(NEAR))).target).toBe(NEAR);
    expect(toggle(toggle(zoom(FAR))).target).toBe(FAR);
  });

  test("toggling follows the target, so a reversal mid-movement turns back", () => {
    const widening = ease(ease(to(zoom(NEAR), FAR)));
    expect(widening.scale).toBeLessThan(NEAR);
    expect(widening.scale).toBeGreaterThan(FAR);
    const turned = toggle(widening);
    expect(turned.target).toBe(NEAR);
    expect(turned.scale).toBe(widening.scale);
  });

  test("toggling from a target between the two closes in", () => {
    expect(toggle(zoom(0.5)).target).toBe(NEAR);
    expect(toggle(zoom(0.99)).target).toBe(NEAR);
  });

  test("easing settles exactly on the target in a bounded number of steps", () => {
    expect(settle(to(zoom(NEAR), FAR))).toEqual({ held: { scale: 0, target: 0 }, steps: 14 });
    expect(settle(to(zoom(FAR), NEAR))).toEqual({ held: { scale: 1, target: 1 }, steps: 14 });
    expect(settle(to(zoom(NEAR), 0.5)).held.scale).toBe(0.5);
  });

  test("the scale never leaves its range while easing", () => {
    let held = to(zoom(NEAR), FAR);
    for (let step = 0; step < 40; step++) {
      held = ease(held);
      expect(held.scale).toBeGreaterThanOrEqual(FAR);
      expect(held.scale).toBeLessThanOrEqual(NEAR);
    }
  });

  test("easing a steady zoom is a fixed point", () => {
    const held = zoom(FAR);
    expect(ease(held)).toBe(held);
    const arrived = settle(to(zoom(NEAR), FAR)).held;
    expect(ease(arrived)).toBe(arrived);
  });

  test("detail holds while the surface is close", () => {
    expect(detailed(zoom(NEAR))).toBe(true);
    expect(detailed(zoom(0.9))).toBe(true);
    expect(detailed(zoom(FAR))).toBe(false);
    expect(detailed(zoom(0.4))).toBe(false);
  });

  test("the detail threshold is the first scale that drops detail", () => {
    expect(DETAIL).toBe(0.72);
    expect(detailed(zoom(DETAIL))).toBe(false);
    expect(detailed(zoom(DETAIL + 0.001))).toBe(true);
  });

  test("a caller may set its own detail threshold", () => {
    expect(detailed(zoom(0.5), 0.4)).toBe(true);
    expect(detailed(zoom(0.5), 0.6)).toBe(false);
    expect(detailed(zoom(FAR), -1)).toBe(true);
  });

  test("detail follows the scale rather than the target", () => {
    const widening = to(zoom(NEAR), FAR);
    expect(detailed(widening)).toBe(true);
    expect(detailed(settle(widening).held)).toBe(false);
  });

  test("detail drops once on the way out and stays dropped", () => {
    let held = to(zoom(NEAR), FAR);
    let dropped = false;
    while (!steady(held)) {
      held = ease(held);
      if (!detailed(held)) dropped = true;
      if (dropped) expect(detailed(held)).toBe(false);
    }
    expect(dropped).toBe(true);
  });
});
