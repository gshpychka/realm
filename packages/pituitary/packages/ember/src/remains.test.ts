import { describe, expect, test } from "bun:test";
import { cinderLights, cinders, flight } from "./cinders.ts";
import { ASH, bank, coalColour, coalLights, smoulder } from "./coals.ts";
import { FLAME, glow } from "./ramp.ts";
import { billow, plume, puffs, smokeRamp } from "./smoke.ts";

describe("coals", () => {
  test("a bed holds one coal per cell, each one to three eighths high", () => {
    const bed = bank(12);
    expect(bed).toHaveLength(12);
    for (const coal of bed) expect([1, 2, 3]).toContain(coal.height);
  });

  test("a coal keeps its glyph over time while its colour breathes", () => {
    const [coal] = bank(1, { seed: 3 });
    if (!coal) throw new Error("no coal");
    const moments = Array.from({ length: 40 }, (_, step) => smoulder(coal, step * 200));
    expect(new Set(moments.map((glowing) => glowing.char)).size).toBe(1);
    expect(new Set(moments.map((glowing) => coalColour(glowing, ASH))).size).toBeGreaterThan(1);
  });

  test("glowing coals never go out", () => {
    for (const coal of bank(8)) {
      expect(smoulder(coal, 3_600_000).gone).toBe(0);
      expect(smoulder(coal, 3_600_000).heat).toBeGreaterThan(0.25);
    }
  });

  test("every coal is out by its cooling time, and not all at once", () => {
    const bed = bank(8, { cooling: 60_000 });
    for (const coal of bed) {
      expect(smoulder(coal, 0).gone).toBe(0);
      expect(smoulder(coal, 60_000).gone).toBe(1);
      expect(smoulder(coal, 60_000).heat).toBe(0);
    }
    expect(new Set(bed.map((coal) => coal.out)).size).toBe(bed.length);
    expect(Math.min(...bed.map((coal) => coal.out))).toBeGreaterThanOrEqual(60_000 * 0.45);
  });

  test("a coal going out fades toward the colour it ends in", () => {
    const [coal] = bank(1, { cooling: 10_000 });
    if (!coal) throw new Error("no coal");
    expect(coalColour(smoulder(coal, 0), ASH)).toBe(coalColour({ ...smoulder(coal, 0), gone: 0 }, "#000000"));
    expect(coalColour(smoulder(coal, coal.out), ASH)).toBe(ASH);
    expect(coalColour(smoulder(coal, coal.out), "#282828")).toBe("#282828");
  });

  test("a bed gives warm light from each lit coal, stronger from a taller one, and none once out", () => {
    const bed = bank(6, { cooling: 10_000 });
    const found = coalLights(bed, 0);
    expect(found).toHaveLength(6);
    for (const light of found) {
      expect(light.colour[0]).toBeGreaterThan(light.colour[2]);
      expect(light.y).toBeGreaterThan(0.8);
      expect(light.y).toBeLessThan(1);
    }
    const same = { heat: 0.5, period: 4000, phase: 0, out: Infinity };
    const [low, high] = coalLights(
      [
        { ...same, height: 1 },
        { ...same, height: 3 },
      ],
      0,
    );
    expect((high?.power ?? 0) / (low?.power ?? 1)).toBeCloseTo(3);
    expect(coalLights(bed, 10_000)).toEqual([]);
  });
});

describe("smoke", () => {
  test("rises only from the rows above its base", () => {
    const smoke = plume(4, 2, 1);
    let seen = 0;
    for (let step = 0; step < 40; step++) {
      billow(smoke, step * 140);
      for (const puff of puffs(smoke)) {
        expect(puff.y).toBeLessThan(0);
        expect(puff.y).toBeGreaterThanOrEqual(-2);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("more smoke is thicker and lasts longer", () => {
    const thin = plume(4, 2, 0);
    const thick = plume(4, 2, 1);
    expect(thin.intensity).toBeCloseTo(0.3);
    expect(thick.intensity).toBeCloseTo(0.8);
    expect(thin.lasting).toBe(2000);
    expect(thick.lasting).toBe(10_000);
  });

  test("clears once its fuel has died away", () => {
    const smoke = plume(4, 2, 0.4);
    for (let elapsed = 0; elapsed < smoke.lasting + 4000; elapsed += 140) billow(smoke, elapsed);
    expect(puffs(smoke)).toEqual([]);
  });

  test("greys from a haze over the fill toward fg4 as it thickens", () => {
    const [haze, thick] = smokeRamp("#282828");
    expect(haze?.colour).toBe("#48443f");
    expect(thick?.colour).toBe("#827768");
  });
});

describe("cinders", () => {
  test("rise about a row and a half a second, drifting a little", () => {
    for (const cinder of cinders(4, 8)) {
      const start = flight(cinder, cinder.born);
      const later = flight(cinder, cinder.born + 1000);
      if (!start || !later) throw new Error("out too soon");
      expect(start.y - later.y).toBeGreaterThan(1);
      expect(start.y - later.y).toBeLessThan(2);
      expect(Math.abs(later.x - start.x)).toBeLessThan(0.5);
    }
  });

  test("fade from a bright spark to a dim one and go out", () => {
    for (const cinder of cinders(4, 8)) {
      const fresh = flight(cinder, cinder.born);
      const late = flight(cinder, cinder.born + cinder.life * 0.9);
      expect(fresh?.char).toBe("•");
      expect(late?.char).toBe("·");
      expect(late?.heat ?? 1).toBeLessThan(fresh?.heat ?? 0);
      expect(flight(cinder, cinder.born + cinder.life + 1)).toBeNull();
      expect(flight(cinder, cinder.born - 1)).toBeNull();
    }
  });

  test("burn for about two seconds, and glow in the flame's colours", () => {
    const thrown = cinders(10, 40);
    const mean = thrown.reduce((sum, cinder) => sum + cinder.life, 0) / thrown.length;
    expect(mean).toBeGreaterThan(1700);
    expect(mean).toBeLessThan(2300);
    const [first] = thrown;
    const at = first ? flight(first, first.born) : null;
    expect(glow(at?.heat ?? 0)).not.toBe(FLAME[0]?.colour);
    expect(cinderLights(thrown, 5000)).toEqual([]);
    expect(cinderLights(thrown, 500).length).toBeGreaterThan(0);
  });
});
