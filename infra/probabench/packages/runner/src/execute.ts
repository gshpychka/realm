// Executes a confirmed plan. The OpenRouter key and the history file are checked
// before any paid request; each target's run is then appended as soon as it
// completes, so a later failure keeps every completed run.
import type * as HttpClient from "@effect/platform/HttpClient";
import { type Run, summarizeRun } from "@probabench/domain";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { type MissingApiKey, openrouterClientLayer, openrouterModelLayer } from "./openrouter";
import type { BenchPlan } from "./plan";
import { ResultsStore, type ResultsStoreError } from "./results-store";
import { type LlmError, sweep } from "./sweep";

const describeCompletedRun = (run: Run, out: string): string => {
  const { valid, total, meanCalibrationError } = summarizeRun(run);
  const gap =
    meanCalibrationError === null ? "n/a" : `${(meanCalibrationError * 100).toFixed(1)} pp`;
  return (
    `[${run.model}] run ${run.id} complete: ${valid}/${total} valid, ` +
    `mean calibration gap ${gap} → saved to ${out}`
  );
};

export const executePlan = ({
  targets,
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
    for (const target of targets) {
      yield* Console.log(`[${target.id}] starting sweep`);
      const run = yield* sweep(target, options).pipe(
        Effect.provide(openrouterModelLayer(target, options.maxTokens)),
      );
      yield* store.append(out, run);
      yield* Console.log(describeCompletedRun(run, out));
    }
  }).pipe(Effect.provide(openrouterClientLayer));
