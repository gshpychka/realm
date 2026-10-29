// Executes a confirmed plan. The OpenRouter key and the history file are checked
// before any paid request. All series share adaptive admission; each completed
// sweep is saved immediately, and a provider failure leaves other models working.
import type { PlatformError } from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import { type Run, summarizeRun } from "@probabench/domain";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { ParseError } from "effect/ParseResult";
import type { BenchPlan } from "../plan/plan";
import { type MissingApiKey, openrouterClientLayer } from "../sampling/openrouter";
import type { ProviderFailure } from "../sampling/retry";
import { schedulerLayer } from "../sampling/scheduler";
import { sweep } from "../sampling/sweep";
import { appendRun, prepareHistory } from "../store/results-store";

const describeCompletedRun = (run: Run, out: string): string => {
  const { valid, total } = summarizeRun(run);
  return `[${run.model}] saved ${total} samples (${valid} valid) → ${out}`;
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
    const results = yield* Effect.forEach(
      series,
      (entry) =>
        Effect.gen(function* () {
          yield* Console.log(`[${entry.model}] starting sweep`);
          const result = yield* Effect.either(sweep(entry, options));
          if (Either.isRight(result)) {
            yield* appendRun(out, result.right);
            yield* Console.log(describeCompletedRun(result.right, out));
          } else {
            yield* Console.error(`[${entry.model}] sampling failed: ${result.left.message}`);
          }
          return result;
        }),
      { concurrency: "unbounded" },
    );
    // One unavailable model must not throw away the other models' paid work.
    const failed = results.find(Either.isLeft);
    if (failed) return yield* Effect.fail(failed.left);
  }).pipe(
    Effect.provide(schedulerLayer(options.concurrency)),
    Effect.provide(openrouterClientLayer),
  );
