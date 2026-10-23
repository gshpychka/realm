// The setup form's model: what it edits, what a new benchmark starts from, and the
// preset its sampling matches.
import {
  DEFAULT_PRESET,
  MODEL_ALIASES,
  type ReasoningMode,
  SAMPLING_PRESETS,
  type SamplingPreset,
} from "@probabench/domain";

/** What the form edits. Number fields can hold 0 or NaN while the user types. */
export interface Settings {
  readonly model: string;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
  readonly reasoning: ReasoningMode | undefined;
  /** Whether the custom sampling inputs are open. */
  readonly custom: boolean;
}

/** A new benchmark starts from the first alias and the default preset. */
export const DEFAULT_SETTINGS: Settings = {
  model: MODEL_ALIASES[0].alias,
  trialsPerStep: DEFAULT_PRESET.trialsPerStep,
  stepPercent: DEFAULT_PRESET.stepPercent,
  // Gentler than the CLI default.
  concurrency: 5,
  reasoning: undefined,
  custom: false,
};

export const presetFor = ({
  trialsPerStep,
  stepPercent,
}: Pick<Settings, "trialsPerStep" | "stepPercent">): SamplingPreset | undefined =>
  SAMPLING_PRESETS.find(
    (preset) => preset.trialsPerStep === trialsPerStep && preset.stepPercent === stepPercent,
  );
