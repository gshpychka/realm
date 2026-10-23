// Executes a confirmed plan. The OpenRouter key and the history file are checked
// before any paid request; each series' run is then appended as soon as it
// completes, so a later failure keeps every completed run.
import type * as HttpClient from "@effect/platform/HttpClient";
import { calibrationErrorText, type Run, summarizeRun } from "@probabench/domain";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { BenchPlan } from "../plan/plan";
import {
  type MissingApiKey,
  openrouterClientLayer,
  openrouterModelLayer,
} from "../sampling/openrouter";
import { type LlmError, sweep } from "../sampling/sweep";
import { ResultsStore, type ResultsStoreError } from "../store/results-store";

const describeCompletedRun = (run: Run, out: string): string => {
  const { valid, total, meanCalibrationError } = summarizeRun(run);
  return (
    `[${run.model}] run ${run.id} complete: ${valid}/${total} valid, ` +
    `mean calibration error ${calibrationErrorText(meanCalibrationError, "n/a")} → saved to ${out}`
  );
};

export const executePlan = ({
  series,
  options,
  out,
}: BenchPlan): Effect.Effect<
  void,
  MissingApiKey | ResultsStoreError | LlmError,
  ResultsStore | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const store = yield* ResultsStore;
    yield* store.prepare(out);
    for (const entry of series) {
      yield* Console.log(`[${entry.id}] starting sweep`);
      const run = yield* sweep(entry, options).pipe(
        Effect.provide(openrouterModelLayer(entry, options.maxTokens)),
      );
      yield* store.append(out, run);
      yield* Console.log(describeCompletedRun(run, out));
    }
  }).pipe(Effect.provide(openrouterClientLayer));
