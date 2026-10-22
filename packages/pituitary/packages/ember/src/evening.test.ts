import { describe, expect, test } from "bun:test";
import { paint, pixels } from "./cells.ts";
import { blend, type Evening, evening, FIREPLACE, type FireplacePhase, temperAt } from "./evening.ts";
import { even, flame } from "./fuel.ts";
import { kindle, stoke, warm } from "./hearth.ts";
import { seeded } from "./random.ts";

/** Every phase an evening passes through over `hours`, with when it began and how long it lasted. */
function visits(fire: Evening<FireplacePhase>, hours: number) {
  const out: { phase: FireplacePhase; since: number; lasts: number }[] = [];
  for (let seconds = 0; seconds <= hours * 3600; seconds += 5) {
    temperAt(fire, seconds);
    if (out.at(-1)?.since !== fire.since)
      out.push({ phase: fire.phase, since: fire.since, lasts: fire.lasts });
  }
  return out;
}

describe("an evening", () => {
  test("passes from phase to phase only along the edges each phase allows", () => {
    const seen = visits(evening(FIREPLACE, "steady", seeded(3)), 12);
    expect(seen.length).toBeGreaterThan(100);
    for (let index = 1; index < seen.length; index++) {
      const from = seen[index - 1]?.phase ?? "steady";
      const allowed = FIREPLACE[from].next.map(([name]) => name);
      expect(allowed).toContain(seen[index]?.phase ?? "steady");
    }
    expect(new Set<string>(seen.map((visit) => visit.phase))).toEqual(new Set(Object.keys(FIREPLACE)));
  });

  test("stays in each phase for a dwell within its range, each ending where the next begins", () => {
    const seen = visits(evening(FIREPLACE, "catching", seeded(8)), 12);
    for (let index = 0; index < seen.length; index++) {
      const visit = seen[index];
      if (!visit) continue;
      const [low, high] = FIREPLACE[visit.phase].dwell;
      expect(visit.lasts).toBeGreaterThanOrEqual(low);
      expect(visit.lasts).toBeLessThanOrEqual(high);
      const next = seen[index + 1];
      if (next) expect(next.since).toBeCloseTo(visit.since + visit.lasts, 9);
    }
  });

  test("burns without a jump from one moment to the next, through every change of phase", () => {
    const fire = evening(FIREPLACE, "embers", seeded(5));
    let last = temperAt(fire, 0);
    let changes = 0;
    let phase = fire.phase;
    for (let seconds = 0.1; seconds < 3 * 3600; seconds += 0.1) {
      const now = temperAt(fire, seconds);
      if (fire.phase !== phase) changes++;
      phase = fire.phase;
      for (const key of ["intensity", "reach", "turbulence", "flicker", "flickerRate", "point"] as const)
        expect(Math.abs((now.options[key] ?? 0) - (last.options[key] ?? 0))).toBeLessThan(0.01);
      expect(Math.abs(now.pace - last.pace)).toBeLessThan(1);
      last = now;
    }
    expect(changes).toBeGreaterThan(20);
  });

  test("changes fuel halfway through a change of phase, once the blend is past its middle", () => {
    const from = { pace: 200, options: { fuel: flame, intensity: 1 } };
    const to = { pace: 300, options: { fuel: even, intensity: 0.5 } };
    expect(blend(from, to, 0.49).options.fuel).toBe(flame);
    expect(blend(from, to, 0.5).options.fuel).toBe(even);
    expect(blend(from, to, 0.25)).toEqual({ pace: 225, options: { fuel: flame, intensity: 0.875 } });
  });

  test("wanders within a phase, never far from the phase's own intensity", () => {
    const fire = evening(FIREPLACE, "steady", seeded(2));
    const base = FIREPLACE.steady.options.intensity ?? 0;
    const seen = new Set<number>();
    for (let seconds = 0; seconds < 60; seconds += 1) {
      const intensity = temperAt(fire, seconds).options.intensity ?? 0;
      expect(fire.phase).toBe("steady");
      expect(Math.abs(intensity / base - 1)).toBeLessThanOrEqual(0.1);
      seen.add(Math.round(intensity * 1000));
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  test("the same seed burns the same evening", () => {
    const one = evening(FIREPLACE, "steady", seeded(11));
    const two = evening(FIREPLACE, "steady", seeded(11));
    for (let seconds = 0; seconds < 3600; seconds += 7)
      expect(temperAt(one, seconds)).toEqual(temperAt(two, seconds));
    expect(visits(evening(FIREPLACE, "steady", seeded(12)), 1)).not.toEqual(
      visits(evening(FIREPLACE, "steady", seeded(11)), 1),
    );
  });

  test("never ends, however long it burns and however far a reading jumps", () => {
    const fire = evening(FIREPLACE, "steady", seeded(4));
    const late = temperAt(fire, 30 * 24 * 3600);
    expect(fire.since).toBeLessThanOrEqual(30 * 24 * 3600);
    expect(fire.since + fire.lasts).toBeGreaterThan(30 * 24 * 3600);
    expect(late.options.intensity).toBeGreaterThan(0);
    expect(late.pace).toBeGreaterThanOrEqual(200);
  });

  test("steps no faster than every 200 ms in any phase", () => {
    for (const phase of Object.values(FIREPLACE)) expect(phase.pace).toBeGreaterThanOrEqual(200);
  });
});

describe("a fireplace", () => {
  /** The share of steps in which some flame of a fire `cols` cells wide in `phase` reaches the top of its row. */
  function topping(phase: FireplacePhase, cols: number): number {
    const [width, height] = pixels("eighths", cols, 1);
    const hearth = warm(kindle(width, height, FIREPLACE[phase].options));
    let tops = 0;
    for (let step = 0; step < 500; step++) {
      stoke(hearth);
      if (paint(hearth, "eighths", cols, 1).some((cell) => cell?.char === "█")) tops++;
    }
    return tops / 500;
  }

  test("burning steadily in a row eight cells wide, sends a tongue to the top of the row every few steps", () => {
    expect(topping("steady", 8)).toBeGreaterThan(0.2);
  });

  test("roars to the top of its row, and burns down to embers well below it", () => {
    expect(topping("roaring", 8)).toBeGreaterThan(0.8);
    expect(topping("embers", 8)).toBe(0);
  });
});
