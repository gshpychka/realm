import { describe, expect, test } from "bun:test";
import { MAPPINGS, paint, pixels } from "./cells.ts";
import { arch, even, flame } from "./fuel.ts";
import { type Hearth, heatAt, kindle, reshape, resolve, stoke, warm } from "./hearth.ts";
import { noise } from "./noise.ts";
import { FLAME, glow, lit, SPENT } from "./ramp.ts";

/** A hearth whose heat is set by hand, row 0 at the top. */
function fixed(rows: number[][]): Hearth {
  const hearth = kindle(rows[0]?.length ?? 1, rows.length);
  rows.flat().forEach((heat, index) => {
    hearth.heat[index] = heat;
  });
  return hearth;
}

/** Mean heat per row over `steps` steps, top row first. */
function profile(hearth: Hearth, steps = 300): number[] {
  const sums = new Array(hearth.height).fill(0);
  for (let step = 0; step < steps; step++) {
    stoke(hearth);
    for (let y = 0; y < hearth.height; y++) {
      for (let x = 0; x < hearth.width; x++) sums[y] += heatAt(hearth, x, y) / hearth.width;
    }
  }
  return sums.map((sum) => sum / steps);
}

/** Mean heat at one pixel over `steps` steps. */
function average(hearth: Hearth, x: number, y: number, steps = 300): number {
  let sum = 0;
  for (let step = 0; step < steps; step++) {
    stoke(hearth);
    sum += heatAt(hearth, x, y);
  }
  return sum / steps;
}

describe("colour", () => {
  test("heat at or below the first stop is out", () => {
    expect(lit(0)).toBe(false);
    expect(lit(SPENT)).toBe(false);
    expect(lit(Number.NaN)).toBe(false);
    expect(lit(SPENT + 0.01)).toBe(true);
  });

  test("the gradient passes through each stop and blends between them", () => {
    for (const stop of FLAME) expect(glow(stop.at)).toBe(stop.colour);
    const between = glow(((FLAME[3]?.at ?? 0) + (FLAME[4]?.at ?? 0)) / 2);
    expect(between).not.toBe(FLAME[3]?.colour ?? "");
    expect(between).not.toBe(FLAME[4]?.colour ?? "");
  });

  test("heat past the ends holds the end colours", () => {
    expect(glow(0)).toBe(FLAME[0]?.colour ?? "");
    expect(glow(2)).toBe(FLAME.at(-1)?.colour ?? "");
  });
});

describe("noise", () => {
  test("is smooth, in range, and the same for the same seed", () => {
    const field = noise(7);
    expect(field(1.25, 3.5)).toBe(noise(7)(1.25, 3.5));
    expect(Math.abs(field(1.25, 3.5) - field(1.26, 3.5))).toBeLessThan(0.05);
    for (let x = 0; x < 50; x += 0.37) {
      const value = field(x, x * 0.7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("hearth", () => {
  test("a seed burns the same way every time", () => {
    const a = warm(kindle(12, 8, { seed: 7 }));
    const b = warm(kindle(12, 8, { seed: 7 }));
    expect([...a.heat]).toEqual([...b.heat]);
  });

  test("heat stays within 0..1", () => {
    const hearth = warm(kindle(20, 10, { fuel: even, intensity: 1.5 }));
    for (let step = 0; step < 50; step++) stoke(hearth);
    for (const heat of hearth.heat) {
      expect(heat).toBeGreaterThanOrEqual(0);
      expect(heat).toBeLessThanOrEqual(1);
    }
  });

  test("a fire one pixel tall is a lit strip", () => {
    const [row] = profile(warm(kindle(40, 1)));
    expect(row).toBeGreaterThan(0.5);
  });

  test("heat falls as it rises, and a flame fed to reach most of the height is nearly out at the top", () => {
    const rows = profile(warm(kindle(8, 30, { reach: 0.7 })));
    expect(rows.at(-1) ?? 0).toBeGreaterThan(rows[15] ?? 1);
    expect(rows[15] ?? 0).toBeGreaterThan(rows[0] ?? 1);
    expect(rows[0] ?? 1).toBeLessThan(0.15);
  });

  test("a longer reach keeps heat higher up", () => {
    const short = profile(warm(kindle(8, 30, { reach: 0.5 })));
    const long = profile(warm(kindle(8, 30, { reach: 1.3 })));
    expect(long[10] ?? 0).toBeGreaterThan(short[10] ?? 1);
  });

  test("a column one pixel wide keeps its flame against its walls", () => {
    const rows = profile(warm(kindle(1, 30, { reach: 1.2 })));
    expect(rows[15] ?? 0).toBeGreaterThan(0.2);
  });

  test("an arch leaves the margins cooler than the centre", () => {
    const centre = average(warm(kindle(21, 6, { fuel: arch, turbulence: 0, sway: 0 })), 10, 5);
    const margin = average(warm(kindle(21, 6, { fuel: arch, turbulence: 0, sway: 0 })), 0, 5);
    expect(centre).toBeGreaterThan(margin * 2);
  });

  test("a point takes the margins out before the centre", () => {
    const fire = () => warm(kindle(9, 12, { point: 3, turbulence: 0, sway: 0 }));
    expect(average(fire(), 4, 4)).toBeGreaterThan(average(fire(), 0, 4) * 1.5);
  });

  test("steady wind carries the flame downwind", () => {
    const downwind = average(warm(kindle(21, 12, { fuel: arch, lean: 1, turbulence: 0, sway: 0 })), 15, 4);
    const upwind = average(warm(kindle(21, 12, { fuel: arch, lean: 1, turbulence: 0, sway: 0 })), 5, 4);
    expect(downwind).toBeGreaterThan(upwind);
  });

  test("sparks fly only in a hearth tall enough for them, and stay inside it", () => {
    const tall = warm(kindle(40, 20, { sparks: 20 }));
    expect(tall.sparks.length).toBeGreaterThan(0);
    for (const spark of tall.sparks) {
      expect(spark.x).toBeGreaterThanOrEqual(0);
      expect(spark.x).toBeLessThan(40);
    }
    expect(warm(kindle(40, 3, { sparks: 20 })).sparks).toHaveLength(0);
  });

  test("the scaled defaults follow the size, and a given value wins", () => {
    expect(resolve(40, 40, {}).rise).toBeGreaterThan(resolve(40, 4, {}).rise);
    expect(resolve(40, 40, {}).scale).toBeGreaterThan(resolve(4, 4, {}).scale);
    expect(resolve(40, 40, { rise: 0.9, scale: 3 })).toMatchObject({ rise: 0.9, scale: 3 });
  });
});

describe("cells", () => {
  test("every mapping fills exactly the cells it is given", () => {
    for (const mapping of MAPPINGS) {
      const [w, h] = pixels(mapping, 5, 3);
      expect(paint(warm(kindle(w, h)), mapping, 5, 3)).toHaveLength(15);
    }
  });

  test("half stacks two pixels, top as the glyph and bottom behind it", () => {
    const [cell] = paint(fixed([[0.4], [1]]), "half", 1, 1);
    expect(cell).toMatchObject({ char: "▀", bg: 1 });
    expect(cell?.fg).toBeCloseTo(0.4);
  });

  test("half draws a lone lower pixel as a low block over a clear cell", () => {
    expect(paint(fixed([[0], [1]]), "half", 1, 1)[0]).toEqual({ char: "▄", fg: 1, bg: 0 });
  });

  test("two pixels of nearly one heat become a full block", () => {
    expect(paint(fixed([[1], [0.99]]), "half", 1, 1)[0]?.char).toBe("█");
  });

  test("sideways splits the cell left and right", () => {
    expect(paint(fixed([[1, 0]]), "sideways", 1, 1)[0]?.char).toBe("▌");
  });

  test("a quadrant with a pixel unlit keeps its background clear", () => {
    const [cell] = paint(
      fixed([
        [1, 1],
        [1, 0],
      ]),
      "quadrant",
      1,
      1,
    );
    expect(cell).toEqual({ char: "▛", fg: 1, bg: 0 });
  });

  test("a fully lit quadrant splits into a hot and a cool side", () => {
    const [cell] = paint(
      fixed([
        [0.2, 0.2],
        [1, 1],
      ]),
      "quadrant",
      1,
      1,
    );
    expect(cell).toMatchObject({ char: "▄", fg: 1 });
    expect(cell?.bg).toBeCloseTo(0.2);
  });

  test("eighths draw the lit run up from the cell floor", () => {
    const column = [0, 0, 0, 0, 0, 1, 1, 1].map((heat) => [heat]);
    expect(paint(fixed(column), "eighths", 1, 1)[0]?.char).toBe("▃");
  });

  test("a gauge fills to its heat", () => {
    expect(paint(fixed([[0.5]]), "gauge", 1, 1)[0]?.char).toBe("▄");
  });

  test("a taper spreads one bar across every column from the left", () => {
    const cells = paint(fixed([[0.75]]), "taper", 2, 1);
    expect(cells.map((cell) => cell?.char ?? " ").join("")).toBe("█▌");
  });

  test("cold cells draw nothing", () => {
    for (const mapping of MAPPINGS) {
      const [w, h] = pixels(mapping, 2, 2);
      expect(paint(kindle(w, h), mapping, 2, 2).every((cell) => cell === null)).toBe(true);
    }
  });
});

describe("reshape", () => {
  const total = (hearth: Hearth) => hearth.heat.reduce((sum, heat) => sum + heat, 0);
  const mean = (hearth: Hearth) => total(hearth) / hearth.heat.length;

  test("the same fire carries onto a new grid, its heat resampled and its noise and step kept", () => {
    const small = warm(kindle(8, 2, { fuel: flame, seed: 4 }));
    const large = reshape(small, 10, 4, { fuel: flame, seed: 4 });
    expect([large.width, large.height]).toEqual([10, 4]);
    expect(large.heat).toHaveLength(40);
    expect(large.bed).toHaveLength(10);
    expect(large.tick).toBe(small.tick);
    expect(large.flow).toBe(small.flow);
    expect(large.random).toBe(small.random);
    expect(mean(large)).toBeGreaterThan(0.1);
    expect(Math.abs(mean(large) - mean(small))).toBeLessThan(0.1);
  });

  test("a reshaped fire burns on without cooling out, and back again", () => {
    const fire = reshape(warm(kindle(8, 2, { fuel: flame })), 10, 4, { fuel: flame });
    stoke(fire);
    expect(mean(fire)).toBeGreaterThan(0.1);
    const back = reshape(fire, 8, 2, { fuel: flame });
    expect(mean(back)).toBeGreaterThan(0.1);
  });

  test("sparks keep their place on the new grid", () => {
    const fire = kindle(20, 10, {});
    fire.sparks.push({ x: 10, y: 5, heat: 0.5 });
    const half = reshape(fire, 10, 5, {});
    expect(half.sparks).toEqual([{ x: 5, y: 2.5, heat: 0.5 }]);
  });
});
