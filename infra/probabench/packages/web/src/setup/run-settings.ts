// What the setup form starts from and what it shows: presets, defaults and the
// terminal command for a request.
import { MODEL_ALIASES, type Run, SAMPLING_PRESETS, type SamplingPreset } from "@probabench/domain";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { BenchRequest, benchArgs } from "../bridge/protocol";

/** A request handed to the setup form; a new key makes the form take it again. */
export type BenchmarkDraft = BenchRequest & { readonly key: string };

export const PRESET_DESCRIPTIONS: Readonly<Record<SamplingPreset["id"], string>> = {
  quick: "Find the shape",
  standard: "A closer look",
  thorough: "More evidence",
};

/** Gentler than the CLI default of 10; saved runs do not record concurrency, so reruns use it too. */
const BROWSER_CONCURRENCY = 5;

/** A new benchmark starts from the first alias and the Standard preset. */
export const DEFAULT_REQUEST: BenchRequest = {
  model: MODEL_ALIASES[0].alias,
  trialsPerStep: SAMPLING_PRESETS[1].trialsPerStep,
  stepPercent: SAMPLING_PRESETS[1].stepPercent,
  concurrency: BROWSER_CONCURRENCY,
};

export const presetFor = ({
  trialsPerStep,
  stepPercent,
}: Pick<BenchRequest, "trialsPerStep" | "stepPercent">): SamplingPreset | undefined =>
  SAMPLING_PRESETS.find(
    (preset) => preset.trialsPerStep === trialsPerStep && preset.stepPercent === stepPercent,
  );

/** A saved run's settings as a new request, or null when the form cannot express them. */
export const rerunRequest = (run: Run): BenchRequest | null =>
  Option.getOrNull(
    Schema.decodeOption(BenchRequest)({
      model: run.modelSlug,
      trialsPerStep: run.trialsPerStep,
      stepPercent: run.stepPercent,
      concurrency: BROWSER_CONCURRENCY,
      reasoning: run.reasoning,
    }),
  );

/** Plain words stay bare; anything else is single-quoted, apostrophes included, for POSIX shells. */
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_./:@=+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** The run as a command for the infra dev shell's `probabench`, which supplies the key. */
export const benchmarkCommand = (request: BenchRequest): string =>
  ["probabench", ...benchArgs(request)].map(shellWord).join(" ");
