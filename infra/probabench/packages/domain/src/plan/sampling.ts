// The sampling plan: the probability grid a run sweeps, its sizes, the presets and
// what a plan costs.
import * as Schema from "effect/Schema";

/** A target probability as a fraction in [0, 1]. */
export const Probability = Schema.Number.pipe(Schema.between(0, 1), Schema.brand("Probability"));
export type Probability = typeof Probability.Type;

/** Samples drawn at each target probability. */
export const TrialsPerStep = Schema.Int.pipe(Schema.positive());

/** Distance between neighbouring target probabilities, in whole percent. */
export const StepPercent = Schema.Int.pipe(Schema.between(1, 100));

/**
 * Target probabilities {0, step, 2·step, …, 100}% as fractions. Both endpoints are
 * always included, even when the step does not divide 100.
 */
export const probabilityGrid = (stepPercent: number): ReadonlyArray<Probability> =>
  [...Array.from({ length: Math.ceil(100 / stepPercent) }, (_, i) => i * stepPercent), 100].map(
    (percent) => Probability.make(percent / 100),
  );

/**
 * Retries after a sample's first provider attempt. The runner's retry schedule and
 * every budget display read it.
 */
export const MAX_RETRIES = 5;

export interface PlanBudget {
  /** Target probabilities per model. */
  readonly points: number;
  readonly samples: number;
  /** Provider requests if every sample used all its retries. */
  readonly attempts: number;
}

/** What a plan costs across `targets` models. Expects an already validated plan. */
export const planBudget = (
  plan: { readonly trialsPerStep: number; readonly stepPercent: number },
  targets = 1,
): PlanBudget => {
  const points = probabilityGrid(plan.stepPercent).length;
  const samples = targets * points * plan.trialsPerStep;
  return { points, samples, attempts: samples * (MAX_RETRIES + 1) };
};

export const SAMPLING_PRESETS = [
  { id: "quick", label: "Quick", trialsPerStep: 10, stepPercent: 25 },
  { id: "standard", label: "Standard", trialsPerStep: 50, stepPercent: 10 },
  { id: "thorough", label: "Thorough", trialsPerStep: 100, stepPercent: 5 },
] as const;
export type SamplingPreset = (typeof SAMPLING_PRESETS)[number];
