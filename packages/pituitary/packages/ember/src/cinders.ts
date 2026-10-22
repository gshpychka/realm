import { type Light, linear } from "./light.ts";
import { glow } from "./ramp.ts";
import { seeded } from "./random.ts";

/** A spark thrown up from a bed, in cells from the top-left of the bed's row, and milliseconds. */
export interface Cinder {
  x: number;
  y: number;
  /** Cells per millisecond across; negative drifts towards x = 0. */
  vx: number;
  /** Cells per millisecond down; negative rises. */
  vy: number;
  /** Milliseconds after the throw at which it leaves the bed. */
  born: number;
  /** Milliseconds it burns once it has left. */
  life: number;
}

export interface ThrowOptions {
  /** Milliseconds a cinder burns, on average. Default 2000. */
  life?: number;
  seed?: number;
}

/**
 * `count` cinders thrown from the top edge of a bed `width` cells across, rising about 1.5 rows a
 * second with a little drift, leaving within the first 400 ms.
 */
export function cinders(
  width: number,
  count: number,
  { life = 2000, seed = 13 }: ThrowOptions = {},
): Cinder[] {
  const random = seeded(seed);
  return Array.from({ length: Math.max(0, Math.round(count)) }, () => ({
    x: random() * width,
    y: 0.6,
    vx: (random() - 0.5) * 0.0008,
    vy: -(0.0011 + random() * 0.0008),
    born: random() * 400,
    life: life * (0.75 + 0.5 * random()),
  }));
}

/** Where a cinder is and how it burns: `•` while fresh, then `·` as it fades; `heat` falls to 0. */
export interface Flight {
  x: number;
  y: number;
  char: string;
  heat: number;
}

/** `cinder` `elapsed` milliseconds after the throw, or null before it leaves and once it is out. */
export function flight(cinder: Cinder, elapsed: number): Flight | null {
  const age = elapsed - cinder.born;
  if (age < 0 || age > cinder.life) return null;
  const left = 1 - age / cinder.life;
  return {
    x: cinder.x + cinder.vx * age,
    y: cinder.y + cinder.vy * age,
    char: age < cinder.life * 0.35 ? "•" : "·",
    heat: 0.85 * left,
  };
}

/** The light cinders give off `elapsed` milliseconds after the throw, in the bed's cells. */
export function cinderLights(thrown: readonly Cinder[], elapsed: number): Light[] {
  const colour = linear(glow(0.7));
  const out: Light[] = [];
  for (const cinder of thrown) {
    const at = flight(cinder, elapsed);
    if (at) out.push({ x: at.x, y: at.y, colour, power: 0.03 * (at.heat / 0.85) });
  }
  return out;
}
