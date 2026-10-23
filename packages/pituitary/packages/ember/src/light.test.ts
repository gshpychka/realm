import { describe, expect, test } from "bun:test";
import { pixels } from "./cells.ts";
import { type Hearth, kindle, warm } from "./hearth.ts";
import { irradiance, type Light, lights, shine } from "./light.ts";

/** A hearth whose heat is set by hand, row 0 at the top. */
function fixed(rows: number[][]): Hearth {
  const hearth = kindle(rows[0]?.length ?? 1, rows.length);
  rows.flat().forEach((heat, index) => {
    hearth.heat[index] = heat;
  });
  return hearth;
}

/** A white light of power 1 at the centre of cell (0, 0). */
const lamp: Light = { x: 0.5, y: 0.5, colour: [1, 1, 1], power: 1 };

/** Two columns of `half` cells, three rows tall, lit at `heat` in the bottom cell row alone. */
function bedded(heat: number): Hearth {
  return fixed([
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [heat, heat],
    [heat, heat],
  ]);
}

describe("irradiance", () => {
  test("light falls to half at the radius", () => {
    expect(irradiance([lamp], 0, 0, { radius: 3 })[0]).toBeCloseTo(1);
    expect(irradiance([lamp], 3, 0, { radius: 3 })[0]).toBeCloseTo(0.5);
  });

  test("with cells twice as tall as wide, a cell one row away is as lit as one two columns away", () => {
    expect(irradiance([lamp], 0, 1, { aspect: 2 })).toEqual(irradiance([lamp], 2, 0, { aspect: 2 }));
  });

  test("nothing arrives past the reach", () => {
    expect(irradiance([lamp], 17, 0, { radius: 3 })[0]).toBeGreaterThan(0);
    expect(irradiance([lamp], 19, 0, { radius: 3 })).toEqual([0, 0, 0]);
    expect(irradiance([lamp], 5, 0, { radius: 3, reach: 4 })).toEqual([0, 0, 0]);
  });

  test("light from several sources sums", () => {
    const [one] = irradiance([lamp], 2, 0);
    const [two] = irradiance([lamp, lamp], 2, 0);
    expect(two).toBeCloseTo(one * 2);
  });
});

describe("lights", () => {
  test("a cold hearth gives no light", () => {
    const [w, h] = pixels("half", 4, 2);
    expect(lights(kindle(w, h), "half", 4, 2)).toEqual([]);
  });

  test("a fire lit only in its bottom row places its lights there, one per column", () => {
    const found = lights(bedded(0.5), "half", 2, 3);
    expect(found.map((light) => light.x)).toEqual([0.5, 1.5]);
    for (const light of found) expect(light.y).toBeCloseTo(2.5);
  });

  test("power is the light a column's heat radiates, one for a full cell at heat 1", () => {
    const [cool] = lights(bedded(0.5), "half", 2, 3);
    const [hot] = lights(bedded(1), "half", 2, 3);
    expect(cool?.power).toBeCloseTo(0.0625);
    expect(hot?.power).toBeCloseTo(1);
  });

  test("doubling a column's heat multiplies its power by sixteen", () => {
    const [cool] = lights(bedded(0.25), "half", 2, 3);
    const [hot] = lights(bedded(0.5), "half", 2, 3);
    expect((hot?.power ?? 0) / (cool?.power ?? 1)).toBeCloseTo(16);
  });

  test("firelight is warm", () => {
    const [w, h] = pixels("quadrant", 6, 3);
    const found = lights(warm(kindle(w, h)), "quadrant", 6, 3);
    expect(found.length).toBeGreaterThan(0);
    for (const { colour } of found) {
      expect(colour[0]).toBeGreaterThan(colour[1]);
      expect(colour[1]).toBeGreaterThan(colour[2]);
    }
  });
});

describe("shine", () => {
  test("no light leaves a colour unchanged", () => {
    expect(shine("#504945", [0, 0, 0])).toBe("#504945");
    expect(shine("#504945", [0, 0, 0], { sheen: 1 })).toBe("#504945");
  });

  test("black stays black without sheen, and a sheen lights it", () => {
    expect(shine("#000000", [0.8, 0.4, 0.1])).toBe("#000000");
    expect(shine("#000000", [0.8, 0.4, 0.1], { sheen: 0.5 })).not.toBe("#000000");
  });

  test("light never darkens a channel", () => {
    const channels = (colour: string) => [1, 3, 5].map((at) => Number.parseInt(colour.slice(at, at + 2), 16));
    for (const colour of ["#282828", "#504945", "#83a598", "#fe8019", "#ebdbb2"]) {
      const lit = channels(shine(colour, [0.6, 0.3, 0.05], { sheen: 0.2 }));
      channels(colour).forEach((channel, index) => {
        expect(lit[index] ?? 0).toBeGreaterThanOrEqual(channel);
      });
    }
  });

  test("a lighter surface shows more of the light", () => {
    const gain = (colour: string) =>
      Number.parseInt(shine(colour, [0.5, 0.5, 0.5]).slice(1, 3), 16) -
      Number.parseInt(colour.slice(1, 3), 16);
    expect(gain("#808080")).toBeGreaterThan(gain("#202020"));
  });

  test("light saturates at white", () => {
    expect(shine("#ffffff", [1, 1, 1])).toBe("#ffffff");
    expect(shine("#808080", [100, 100, 100])).toBe("#ffffff");
  });
});
