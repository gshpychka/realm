import { paint } from "./cells.ts";
import { even } from "./fuel.ts";
import { type Hearth, kindle, stoke } from "./hearth.ts";
import { mix, type Stop } from "./ramp.ts";

/** Smoke rising from a spent fire: a hearth of drifting haze whose fuel dies away over `lasting`. */
export interface Plume {
  hearth: Hearth;
  /** The haze the plume starts with. */
  intensity: number;
  /** Milliseconds until its fuel is gone. */
  lasting: number;
}

/** Smoke `width` cells across and `rows` tall, thicker and longer lasting with `amount`, 0..1. */
export function plume(width: number, rows: number, amount: number, seed = 5): Plume {
  const thickness = Math.min(1, Math.max(0, amount));
  const intensity = 0.3 + 0.5 * thickness;
  return {
    hearth: kindle(width, rows, {
      fuel: even,
      intensity,
      reach: 1.1,
      turbulence: 1.2,
      lean: 0.15,
      sway: 0.4,
      flicker: 0.5,
      flickerRate: 0.3,
      sparks: 0,
      seed,
    }),
    intensity,
    lasting: 2000 + 8000 * thickness,
  };
}

/** Advances the plume one step, `elapsed` milliseconds after it began. */
export function billow(smoke: Plume, elapsed: number): void {
  const left = Math.max(0, 1 - elapsed / smoke.lasting);
  smoke.hearth.options = { ...smoke.hearth.options, intensity: smoke.intensity * left };
  stoke(smoke.hearth);
}

/** A cell of smoke: `y` counts rows up from the plume's base, so -1 is the row just above it. */
export interface Puff {
  x: number;
  y: number;
  char: string;
  density: number;
}

/** The plume's puffs, which rise from the row above its base and never cover it. */
export function puffs(smoke: Plume): Puff[] {
  const { width, height } = smoke.hearth;
  const out: Puff[] = [];
  paint(smoke.hearth, "shade", width, height).forEach((cell, index) => {
    if (!cell) return;
    out.push({ x: index % width, y: Math.floor(index / width) - height, char: cell.char, density: cell.fg });
  });
  return out;
}

/** Gruvbox dark's fg4, the grey smoke thickens toward. */
const HAZE = "#a89984";

/** Smoke's colours over `fill`, from a thin haze to its thickest, as `glow` stops. */
export function smokeRamp(fill: string): Stop[] {
  return [
    { at: 0, colour: mix(fill, HAZE, 0.25) },
    { at: 1, colour: mix(fill, HAZE, 0.7) },
  ];
}
