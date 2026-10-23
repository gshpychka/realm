// Run-plan vocabulary shared by the CLI, the dev bridge and the setup form.
import { probabilityGrid, type ReasoningMode } from "../results/schema";

/**
 * Retries after a sample's first provider attempt. The runner's retry schedule and
 * every budget display read it.
 */
export const MAX_RETRIES = 5;

export const REASONING_LABELS: Readonly<Record<ReasoningMode, string>> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

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
