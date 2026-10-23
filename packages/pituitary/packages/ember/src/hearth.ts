import { even, type Fuel } from "./fuel.ts";
import { type Noise, noise } from "./noise.ts";
import { type Random, seeded } from "./random.ts";

/**
 * A fire as a grid of temperature, in pixels, row 0 at the top.
 *
 * A fuel bed beneath the bottom row heats the air above it. Each step the temperature is
 * carried along a velocity field and cools:
 *
 * - The velocity is buoyant lift, stronger where the air is hotter, plus turbulence
 *   taken as the curl of a drifting noise field, which swirls without piling heat up
 *   anywhere, plus wind and a slow sway.
 * - Carrying is semi-Lagrangian: each pixel looks back along the velocity to where its
 *   air came from, so any speed is stable.
 * - Cooling follows a noise field that rises with the flame, so a cool patch keeps
 *   eating the tongue it meets: that carves tongues and pinches off their tips.
 *
 * Sparks leave the bed now and then, ride upward faster than the flame, and fade.
 */
export interface Hearth {
  readonly width: number;
  readonly height: number;
  /** Temperature per pixel, 0..1, row-major. */
  readonly heat: Float32Array;
  /** Temperature the bed beneath each column is feeding upward. */
  readonly bed: Float32Array;
  options: Required<HearthOptions>;
  tick: number;
  readonly previous: Float32Array;
  readonly sparks: Spark[];
  readonly random: Random;
  readonly flow: Noise;
  readonly cooling: Noise;
  readonly detail: Noise;
  readonly flutter: Noise;
}

export interface Spark {
  x: number;
  y: number;
  heat: number;
}

/**
 * How a fire burns. Distances are in pixels of the hearth and rates are per step; the
 * defaults scale with the hearth, so the same options suit a strip, a column, or a tile.
 */
export interface HearthOptions {
  /** How much fuel lies under each point of the width. */
  fuel?: Fuel;
  /** Heat the fuel gives, where 1 burns white at the core. */
  intensity?: number;
  /** Fraction of the height a fully fed flame climbs before it cools out. */
  reach?: number;
  /** Upward speed of the hottest air, in pixels per step. Scales with the height when absent. */
  rise?: number;
  /** Strength of the swirling flow, 0 for a flame that climbs straight. */
  turbulence?: number;
  /** Size of the eddies, in pixels. Scales with the hearth when absent. */
  scale?: number;
  /** How much heat bleeds to its neighbours each step, 0..1. */
  spread?: number;
  /** How unevenly the air cools, 0 for evenly: higher parts the flame into tongues with dark gaps between. */
  patchiness?: number;
  /** Steady wind across the flame, in pixels per step; negative blows towards x = 0. */
  lean?: number;
  /** How far the flame sways from side to side, in pixels per step. */
  sway?: number;
  /** How much faster the margins cool than the centre, so the flame climbs to a point. */
  point?: number;
  /** How deep the bed's heat dips as it flickers, 0..1. */
  flicker?: number;
  /** How fast the bed flickers, in noise cells per step. */
  flickerRate?: number;
  /** Sparks thrown per step for every 100 pixels of width. */
  sparks?: number;
  seed?: number;
}

const DEFAULTS: Omit<Required<HearthOptions>, "rise" | "scale"> = {
  fuel: even,
  intensity: 1.05,
  reach: 1.05,
  turbulence: 0.8,
  spread: 0.15,
  patchiness: 1,
  lean: 0,
  sway: 0.25,
  point: 0,
  flicker: 0.4,
  flickerRate: 0.35,
  sparks: 1.5,
  seed: 1,
};

/** The options in force for a hearth of this size, with the defaults that scale filled in. */
export function resolve(width: number, height: number, options: HearthOptions): Required<HearthOptions> {
  const rise = options.rise ?? clamp(height * 0.07, 0.4, 2.5);
  // Eddies well under the flame's size split it into several tongues; larger ones merge it into a mound.
  const scale = options.scale ?? clamp(Math.min(width, height * 1.5) * 0.12, 1.2, 6);
  return { ...DEFAULTS, rise, scale, ...defined(options) };
}

/** A hearth `width` × `height` pixels, cold until it is stoked. */
export function kindle(width: number, height: number, options: HearthOptions = {}): Hearth {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const resolved = resolve(w, h, options);
  return {
    width: w,
    height: h,
    heat: new Float32Array(w * h),
    previous: new Float32Array(w * h),
    bed: new Float32Array(w),
    options: resolved,
    tick: 0,
    sparks: [],
    random: seeded(resolved.seed),
    flow: noise(resolved.seed),
    cooling: noise(resolved.seed + 101),
    detail: noise(resolved.seed + 303),
    flutter: noise(resolved.seed + 202),
  };
}

/** Advances the fire one step, in place. */
export function stoke(hearth: Hearth): void {
  const { width, height, heat, previous, bed, options, flow, cooling, detail, flutter } = hearth;
  const {
    fuel,
    intensity,
    reach,
    rise,
    turbulence,
    scale,
    spread,
    patchiness,
    lean,
    sway,
    point,
    flicker,
    flickerRate,
  } = options;
  const t = hearth.tick;

  for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width;
    const dip = flicker * flutter(x / Math.max(1, scale * 0.7), t * flickerRate);
    const fed = clamp(fuel(u, t)) * intensity * (1 - dip);
    bed[x] = (bed[x] ?? 0) + (fed - (bed[x] ?? 0)) * 0.5;
  }

  previous.set(heat);
  const wind = lean + sway * Math.sin(t * 0.045) * Math.sin(t * 0.017 + 1.3);
  // The flow field drifts upward with the flame, so eddies climb with it.
  const drift = t * rise * 0.5;
  // Turbulence as the curl of a scalar field: velocity from its slope, which moves heat
  // around without gathering it anywhere.
  const eps = 0.5;
  const swirl = turbulence * scale * 0.9;
  const potential = (x: number, y: number) => flow(x / scale, (y + drift) / scale);
  // A parcel rising at `rise` crosses `reach` of the height in this many steps and loses
  // its heat over them; the cooling field averages about one.
  const loss = (intensity * 0.95 * rise) / Math.max(2, reach * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const here = previous[y * width + x] ?? 0;
      const across = (potential(px, py + eps) - potential(px, py - eps)) / (2 * eps);
      const upward = -(potential(px + eps, py) - potential(px - eps, py)) / (2 * eps);
      const vx = wind + across * swirl;
      // Hot air outruns cool air, which draws the hottest parts up into tongues.
      const vy = rise * (0.3 + 0.9 * Math.min(1, here * 1.3)) + upward * swirl * 0.5;
      // Where this air was a step ago: behind the velocity, below for rising air.
      const sx = px - vx - 0.5;
      const sy = py + vy - 0.5;
      let carried = sampleAt(hearth, sx, sy);
      if (spread > 0) {
        const around =
          (sampleAt(hearth, sx - 1, sy) +
            sampleAt(hearth, sx + 1, sy) +
            sampleAt(hearth, sx, sy - 1) +
            sampleAt(hearth, sx, sy + 1)) /
          4;
        carried += (around - carried) * spread;
      }
      const margin = width === 1 ? 0 : Math.abs((2 * px) / width - 1);
      // The cooling field climbs at the flame's own pace, so a cool patch stays with the tongue it cuts.
      // Two sizes of cool patch: broad ones part the flame into tongues, fine ones fray their edges.
      const broad = cooling(x / (scale * 0.8), (y + t * rise) / (scale * 0.8));
      const fine = detail(x / (scale * 0.35), (y + t * rise) / (scale * 0.35));
      // Averages about one, so patchiness shifts where the air cools and leaves how far the flame climbs.
      const shape = (0.05 + 2 * broad * broad * broad + 1.4 * fine * fine) / 0.87;
      const patchy = 1 + (shape - 1) * patchiness;
      // Air just above the bed has barely begun to cool, so a hearth one pixel tall is lit.
      const nearBed = Math.min(1, (height - py) / 3);
      heat[y * width + x] = clamp(carried - loss * patchy * nearBed * (1 + point * margin * margin));
    }
  }

  throwSparks(hearth, wind);
  hearth.tick++;
}

/**
 * Temperature at a point, bilinear between pixel centres: the bed beneath, cold above.
 * The sides are walls that turn heat back, so a strip one pixel wide keeps its flame;
 * a flame narrows through its fuel and `point`.
 */
function sampleAt(hearth: Hearth, x: number, y: number): number {
  const { width, height, previous, bed } = hearth;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (column: number, row: number): number => {
    if (row < 0) return 0;
    const inside = Math.min(width - 1, Math.max(0, column));
    if (row >= height) return bed[inside] ?? 0;
    return previous[row * width + inside] ?? 0;
  };
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Hearths shorter than this throw no sparks: there is no air above the flame for them to cross. */
const SPARK_HEIGHT = 6;

function throwSparks(hearth: Hearth, wind: number): void {
  const { width, height, heat, bed, random, options, sparks } = hearth;
  if (height < SPARK_HEIGHT || options.sparks <= 0) {
    sparks.length = 0;
    return;
  }
  const expected = (options.sparks * width) / 100;
  let thrown = Math.floor(expected) + (random() < expected % 1 ? 1 : 0);
  while (thrown-- > 0) {
    const x = random() * width;
    const fed = bed[Math.min(width - 1, Math.floor(x))] ?? 0;
    if (random() < fed)
      sparks.push({ x, y: height - 1 - random() * height * 0.3, heat: 0.75 + random() * 0.25 });
  }
  for (let index = sparks.length - 1; index >= 0; index--) {
    const spark = sparks[index];
    if (!spark) continue;
    spark.y -= options.rise * (1.3 + random() * 0.6);
    spark.x += wind + (random() - 0.5) * 0.8;
    spark.heat -= 0.06 + random() * 0.05;
    const column = Math.floor(spark.x);
    const row = Math.floor(spark.y);
    if (spark.heat <= 0 || row < 0 || column < 0 || column >= width) {
      sparks.splice(index, 1);
      continue;
    }
    const cell = row * width + column;
    heat[cell] = Math.max(heat[cell] ?? 0, spark.heat * 0.8);
  }
}

/**
 * The same fire on a grid `width` × `height` pixels: its heat, bed, and sparks resampled to
 * the new grid, its noise, randomness, and step carried over, so it burns on without
 * kindling afresh. `options` are the options for the new shape; the defaults that scale
 * rescale with it.
 */
export function reshape(hearth: Hearth, width: number, height: number, options: HearthOptions = {}): Hearth {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const across = hearth.width / w;
  const down = hearth.height / h;
  return {
    ...hearth,
    width: w,
    height: h,
    heat: resample(hearth.heat, hearth.width, hearth.height, w, h),
    previous: resample(hearth.previous, hearth.width, hearth.height, w, h),
    bed: resample(hearth.bed, hearth.width, 1, w, 1),
    options: resolve(w, h, options),
    sparks: hearth.sparks.map((spark) => ({ ...spark, x: spark.x / across, y: spark.y / down })),
  };
}

/** A grid resampled bilinearly, each new pixel read at its centre's place in the old grid. */
function resample(grid: Float32Array, width: number, height: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => grid[y * width + x] ?? 0;
  for (let y = 0; y < h; y++) {
    const v = clamp(((y + 0.5) * height) / h - 0.5, 0, height - 1);
    const y0 = Math.floor(v);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = v - y0;
    for (let x = 0; x < w; x++) {
      const u = clamp(((x + 0.5) * width) / w - 0.5, 0, width - 1);
      const x0 = Math.floor(u);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = u - x0;
      const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
      const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
      out[y * w + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/** Stokes until the fire has filled its height, for a fire that should already be burning when first seen. */
export function warm(hearth: Hearth, steps?: number): Hearth {
  const count = steps ?? Math.ceil(hearth.height / Math.max(0.25, hearth.options.rise)) * 2 + 12;
  for (let step = 0; step < count; step++) stoke(hearth);
  return hearth;
}

/** Heat at a pixel; 0 outside the hearth. */
export function heatAt(hearth: Hearth, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= hearth.width || y >= hearth.height) return 0;
  return hearth.heat[y * hearth.width + x] ?? 0;
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value));
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
