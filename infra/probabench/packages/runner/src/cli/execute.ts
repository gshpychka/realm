// Executes a confirmed plan. The OpenRouter key and the history file are checked
// before any paid request; each series' run is then appended as soon as it
// completes, so a later failure keeps every completed run.
import type { PlatformError } from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import { calibrationErrorText, type Run, summarizeRun } from "@probabench/domain";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { ParseError } from "effect/ParseResult";
import type { BenchPlan } from "../plan/plan";
import {
  type MissingApiKey,
  openrouterClientLayer,
  openrouterModelLayer,
} from "../sampling/openrouter";
import type { ProviderFailure } from "../sampling/retry";
import { sweep } from "../sampling/sweep";
import { appendRun, prepareHistory } from "../store/results-store";

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
  MissingApiKey | PlatformError | ParseError | ProviderFailure,
  FileSystem.FileSystem | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    yield* prepareHistory(out);
    for (const entry of series) {
      yield* Console.log(`[${entry.model}] starting sweep`);
      const run = yield* sweep(entry, options).pipe(
        Effect.provide(openrouterModelLayer(entry, options.maxTokens)),
      );
      yield* appendRun(out, run);
      yield* Console.log(describeCompletedRun(run, out));
    }
  }).pipe(Effect.provide(openrouterClientLayer));
