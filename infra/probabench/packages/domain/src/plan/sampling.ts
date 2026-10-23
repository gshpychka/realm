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

interface PlanBudget {
  /** Target probabilities per model. */
  readonly points: number;
  readonly samples: number;
}

/** What a plan costs for `models` model series. Expects an already validated plan. */
export const planBudget = (
  plan: { readonly trialsPerStep: number; readonly stepPercent: number },
  models = 1,
): PlanBudget => {
  const points = probabilityGrid(plan.stepPercent).length;
  return { points, samples: models * points * plan.trialsPerStep };
};

const STANDARD = {
  label: "Standard",
  description: "A closer look",
  trialsPerStep: 50,
  stepPercent: 10,
} as const;

export const SAMPLING_PRESETS = [
  { label: "Quick", description: "Find the shape", trialsPerStep: 10, stepPercent: 25 },
  STANDARD,
  { label: "Thorough", description: "More evidence", trialsPerStep: 100, stepPercent: 5 },
] as const;
export type SamplingPreset = (typeof SAMPLING_PRESETS)[number];

/** Sizing when nothing else is chosen: the CLI without --trials/--step, and a new setup form. */
export const DEFAULT_PRESET: SamplingPreset = STANDARD;
