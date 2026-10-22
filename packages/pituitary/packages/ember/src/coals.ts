import { type Light, linear } from "./light.ts";
import { glow, mix } from "./ramp.ts";
import { seeded } from "./random.ts";

/** A coal: glowing fuel of a fixed height, lying in one cell. */
export interface Coal {
  /** Eighths of its cell it fills, up from the floor: 1, 2, or 3. */
  height: number;
  /** The heat it glows at while fresh. */
  heat: number;
  /** Milliseconds one breath of its glow takes. */
  period: number;
  /** Where in its breath it starts, in radians. */
  phase: number;
  /** Milliseconds after it was banked at which it is out; `Infinity` for a coal that stays lit. */
  out: number;
}

export interface BedOptions {
  /** Milliseconds by which every coal is out; `Infinity` keeps them glowing. Default `Infinity`. */
  cooling?: number;
  seed?: number;
}

/** A coal in each of `width` cells, going out one by one within `cooling`. */
export function bank(width: number, { cooling = Infinity, seed = 11 }: BedOptions = {}): Coal[] {
  const random = seeded(seed);
  return Array.from({ length: Math.max(0, Math.floor(width)) }, () => {
    // Mostly low coals, the odd one heaped higher.
    const height = random() < 0.5 ? 1 : random() < 0.75 ? 2 : 3;
    return {
      height,
      heat: 0.38 + random() * 0.22,
      period: 3000 + random() * 3500,
      phase: random() * Math.PI * 2,
      out: cooling * (0.45 + 0.55 * random()),
    };
  });
}

/** How a coal glows at a moment: its glyph, its heat, and how far it has gone out, 0..1. */
export interface Glowing {
  char: string;
  heat: number;
  gone: number;
}

const RISE = ["▁", "▂", "▃"] as const;

/** `coal` `elapsed` milliseconds after it was banked. Its glyph is its height, whatever its heat. */
export function smoulder(coal: Coal, elapsed: number): Glowing {
  const breath = 0.82 + 0.18 * Math.sin((elapsed / coal.period) * Math.PI * 2 + coal.phase);
  const gone = Math.min(1, Math.max(0, elapsed / coal.out)) ** 1.6;
  return { char: RISE[coal.height - 1] ?? RISE[0], heat: coal.heat * breath * (1 - gone), gone };
}

/** Grey ash, gruvbox dark's gray. */
export const ASH = "#928374";

/** The colour a coal glows, fading toward `end` as it goes out: `ASH` for a coal cooling to ash. */
export function coalColour(coal: Glowing, end: string): string {
  // A dying coal keeps the dullest red of the ramp until it is nearly out.
  return mix(glow(Math.max(0.2, coal.heat)), end, coal.gone);
}

/** A hot body radiates with the fourth power of its temperature (Stefan–Boltzmann). */
const RADIANCE = 4;
/** A coal is solid and radiates near a black body, several times a flame's thin gas at the same heat. */
const EMISSIVITY = 4;

/**
 * The light a bed of coals gives off `elapsed` milliseconds after it was banked, one light per coal
 * still lit, in cells from the top-left of the bed's row.
 */
export function coalLights(bed: readonly Coal[], elapsed: number): Light[] {
  const out: Light[] = [];
  bed.forEach((coal, column) => {
    const { heat } = smoulder(coal, elapsed);
    if (heat <= 0) return;
    out.push({
      x: column + 0.5,
      y: 1 - coal.height / 16,
      colour: linear(glow(heat)),
      power: heat ** RADIANCE * (coal.height / 8) * EMISSIVITY,
    });
  });
  return out;
}
