// What the setup form starts from and what it shows: presets and defaults.
import {
  DEFAULT_PRESET,
  MODEL_ALIASES,
  SAMPLING_PRESETS,
  type SamplingPreset,
} from "@probabench/domain";
import type { BenchRequest } from "../bridge/protocol";

/** A new benchmark starts from the first alias and the default preset. */
export const DEFAULT_REQUEST: BenchRequest = {
  model: MODEL_ALIASES[0].alias,
  trialsPerStep: DEFAULT_PRESET.trialsPerStep,
  stepPercent: DEFAULT_PRESET.stepPercent,
  // Gentler than the CLI default.
  concurrency: 5,
};

export const presetFor = ({
  trialsPerStep,
  stepPercent,
}: Pick<BenchRequest, "trialsPerStep" | "stepPercent">): SamplingPreset | undefined =>
  SAMPLING_PRESETS.find(
    (preset) => preset.trialsPerStep === trialsPerStep && preset.stepPercent === stepPercent,
  );
