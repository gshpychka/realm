import { even, flame } from "./fuel.ts";
import { type HearthOptions, resolve } from "./hearth.ts";
import type { Random } from "./random.ts";

/** How a fire burns for a while: its options, and the milliseconds between its steps. */
export interface Temper {
  pace: number;
  options: HearthOptions;
}

/** A stretch of an evening: how the fire burns through it, how long it lasts, and what may follow. */
export interface Phase<Name extends string = string> extends Temper {
  /** Seconds the phase lasts, drawn evenly between the two. */
  dwell: readonly [number, number];
  /** Phases that may follow, each with its weight. */
  next: readonly (readonly [Name, number])[];
}

export type Phases<Name extends string = string> = Readonly<Record<Name, Phase<Name>>>;

/** A fire's evening: which phase it burns in, since when, and for how long, in seconds from its start. */
export interface Evening<Name extends string = string> {
  readonly phases: Phases<Name>;
  readonly random: Random;
  /** The phase before this one, which the fire blends from as the phase begins. */
  previous: Name;
  phase: Name;
  since: number;
  lasts: number;
  /** Where each of the wander's two slow waves starts, in radians. */
  readonly wander: readonly [number, number];
}

/** Seconds a change of phase takes. */
const SHIFT_S = 15;

/** The wander's waves: the share of the intensity each sways by, and seconds per radian. */
const WAVES = [
  [0.06, 37],
  [0.04, 13],
] as const;

/** An evening begun in `first`, drawing its dwells, its next phases, and its wander from `random`. */
export function evening<Name extends string>(
  phases: Phases<Name>,
  first: Name,
  random: Random,
): Evening<Name> {
  const wander = [random() * 2 * Math.PI, random() * 2 * Math.PI] as const;
  return {
    phases,
    random,
    previous: first,
    phase: first,
    since: 0,
    lasts: dwell(phases[first], random),
    wander,
  };
}

/**
 * How the fire burns `seconds` into its evening, never earlier than the last moment asked for.
 * A new phase blends in over its first 15 s; within a phase the intensity wanders slowly.
 */
export function temperAt<Name extends string>(evening: Evening<Name>, seconds: number): Temper {
  const { phases, random } = evening;
  while (seconds - evening.since >= evening.lasts) {
    evening.previous = evening.phase;
    evening.phase = pick(phases[evening.phase].next, random) ?? evening.phase;
    evening.since += evening.lasts;
    evening.lasts = dwell(phases[evening.phase], random);
  }
  const k = Math.min(1, Math.max(0, (seconds - evening.since) / SHIFT_S));
  const temper = blend(phases[evening.previous], phases[evening.phase], k * k * (3 - 2 * k));
  const intensity = resolve(1, 1, temper.options).intensity;
  const sway = WAVES.reduce(
    (sum, [share, period], wave) => sum + share * Math.sin(seconds / period + (evening.wander[wave] ?? 0)),
    0,
  );
  return { pace: temper.pace, options: { ...temper.options, intensity: intensity * (1 + sway) } };
}

/**
 * A temper `t` of the way from `from` to `to`: its pace and every option both give as a number in between,
 * and every other option from whichever side `t` is nearer.
 */
export function blend(from: Temper, to: Temper, t: number): Temper {
  const near: Record<string, unknown> = { ...(t < 0.5 ? from.options : to.options) };
  const start = from.options as Record<string, unknown>;
  const end = to.options as Record<string, unknown>;
  for (const key of Object.keys(near)) {
    const a = start[key];
    const b = end[key];
    if (typeof a === "number" && typeof b === "number") near[key] = a + (b - a) * t;
  }
  return { pace: from.pace + (to.pace - from.pace) * t, options: near as HearthOptions };
}

function dwell(phase: Phase, random: Random): number {
  const [low, high] = phase.dwell;
  return low + random() * (high - low);
}

function pick<Name extends string>(next: Phase<Name>["next"], random: Random): Name | undefined {
  const total = next.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [name, weight] of next) {
    roll -= weight;
    if (roll < 0) return name;
  }
  return next[0]?.[0];
}

export type FireplacePhase = "catching" | "roaring" | "steady" | "settling" | "embers";

/**
 * A fireplace's evening for a fire one cell row tall: it catches, roars, burns steadily, settles, sinks
 * to embers, and catches again as a log goes on. Every phase steps at 200 ms or slower, a pace for a fire
 * left burning on an idle screen.
 */
export const FIREPLACE: Phases<FireplacePhase> = {
  catching: {
    dwell: [20, 40],
    next: [
      ["roaring", 0.7],
      ["steady", 0.3],
    ],
    pace: 200,
    options: {
      fuel: flame,
      intensity: 0.8,
      reach: 1.5,
      turbulence: 0.6,
      flicker: 0.5,
      flickerRate: 0.35,
      point: 0.5,
      sparks: 0,
    },
  },
  roaring: {
    dwell: [40, 90],
    next: [["steady", 1]],
    pace: 200,
    options: {
      fuel: flame,
      intensity: 1,
      reach: 2.3,
      turbulence: 0.6,
      flicker: 0.45,
      flickerRate: 0.3,
      point: 0.35,
      sparks: 0,
    },
  },
  steady: {
    dwell: [60, 150],
    next: [
      ["settling", 0.82],
      ["roaring", 0.18],
    ],
    pace: 200,
    options: {
      fuel: flame,
      intensity: 0.9,
      reach: 1.8,
      turbulence: 0.35,
      flicker: 0.42,
      flickerRate: 0.26,
      point: 0.3,
      sparks: 0,
    },
  },
  settling: {
    dwell: [60, 120],
    next: [
      ["embers", 0.65],
      ["steady", 0.35],
    ],
    pace: 210,
    options: {
      fuel: even,
      intensity: 0.8,
      reach: 1.4,
      turbulence: 0.3,
      flicker: 0.35,
      flickerRate: 0.2,
      point: 0.2,
      sparks: 0,
    },
  },
  embers: {
    dwell: [45, 120],
    next: [
      ["catching", 0.8],
      ["settling", 0.2],
    ],
    pace: 260,
    options: {
      fuel: even,
      intensity: 0.62,
      reach: 1,
      turbulence: 0.25,
      flicker: 0.4,
      flickerRate: 0.15,
      point: 0.1,
      sparks: 0,
    },
  },
};
