// What the setup form starts from and what it shows: presets, defaults and the
// terminal command for a request.
import {
  benchArgs,
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

/** Plain words stay bare; anything else is single-quoted, apostrophes included, for POSIX shells. */
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_./:@=+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** The run as a command for the infra dev shell's `probabench`, which supplies the key. */
export const benchmarkCommand = (request: BenchRequest): string =>
  ["probabench", ...benchArgs(request)].map(shellWord).join(" ");
