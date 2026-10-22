import { describe, expect, test } from "bun:test";
import { gauge, meter, sparkline } from "./bars.ts";

describe("sparkline", () => {
  test("spans the lowest to the highest glyph", () => {
    expect(sparkline([0, 7])).toBe("▁█");
  });

  test("a flat series sits on the floor", () => {
    expect(sparkline([3, 3, 3])).toBe("▁▁▁");
  });

  test("no samples draw nothing", () => {
    expect(sparkline([])).toBe("");
  });
});

describe("meter", () => {
  test("fills its share of the width", () => {
    expect(meter(0.5, 4)).toEqual({ filled: "██", empty: "░░" });
  });

  test("a fraction outside 0..1 is held at the end it passed", () => {
    expect(meter(2, 3)).toEqual({ filled: "███", empty: "" });
    expect(meter(-1, 3)).toEqual({ filled: "", empty: "░░░" });
  });
});

describe("gauge", () => {
  test("fills whole cells, then one eighth-block cell, then leaves the rest empty", () => {
    expect(gauge(0, 8)).toEqual({ filled: "", partial: "", empty: 8 });
    expect(gauge(0.5, 8)).toEqual({ filled: "████", partial: "", empty: 4 });
    expect(gauge(0.43, 8)).toEqual({ filled: "███", partial: "▌", empty: 4 });
    expect(gauge(1.2, 8)).toEqual({ filled: "████████", partial: "", empty: 0 });
  });
});
