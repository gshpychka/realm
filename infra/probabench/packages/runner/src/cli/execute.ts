// Synchronize history and fill the daily deficits. Provider errors stop the affected
// model; storage errors stop sampling and preserve received answers locally.
import * as PlatformError from "@effect/platform/Error";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as ParseResult from "effect/ParseResult";
import { planDaily } from "../plan/daily";
import type { BenchPlan } from "../plan/plan";
import { withProgressDisplay } from "../progress/display";
import { SamplingProgress } from "../progress/observer";
import { type MissingApiKey, openrouterClientLayer } from "../sampling/openrouter";
import type { ProviderFailure } from "../sampling/retry";
import { schedulerLayer } from "../sampling/scheduler";
import { sweep } from "../sampling/sweep";
import { CloudHistory, CloudHistoryError } from "../store/cloud-history";
import {
  type HistoryError,
  type HistoryLockError,
  makeCheckpointer,
  withSharedHistory,
} from "../store/results-store";

export const executePlan = (
  plan: BenchPlan,
): Effect.Effect<
  void,
  MissingApiKey | HistoryError | HistoryLockError | ProviderFailure,
  FileSystem.FileSystem | HttpClient.HttpClient | CloudHistory
> =>
  withSharedHistory(plan.out, (history, upload) =>
    Effect.gen(function* () {
      const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const daily = planDaily(plan, history, startedAt);
      if (daily.remaining === 0) return yield* Console.log("Nothing to collect today.");
      const cloud = yield* CloudHistory;
      yield* cloud.checkWrite;
      const save = makeCheckpointer(plan.out, plan.options, startedAt, upload);
      yield* withProgressDisplay(
        daily,
        plan.options.concurrency,
        Effect.gen(function* () {
          const progress = yield* SamplingProgress;
          const results = yield* Effect.forEach(
            daily.series,
            ({ series, points, remaining }) =>
              Effect.gen(function* () {
                if (remaining === 0) {
                  return Either.right(0);
                }
                const result = yield* Effect.either(
                  sweep(series, plan.options, points, (x, outcome) => save(series, x, outcome)),
                );
                if (Either.isRight(result)) {
                  progress.finished(series.model);
                } else {
                  progress.finished(series.model, result.left.message);
                  if (
                    PlatformError.isPlatformError(result.left) ||
                    result.left instanceof CloudHistoryError ||
                    ParseResult.isParseError(result.left)
                  ) {
                    return yield* Effect.fail(result.left);
                  }
                }
                return result;
              }),
            { concurrency: "unbounded" },
          );
          const failed = results.find(Either.isLeft);
          if (failed) return yield* Effect.fail(failed.left);
        }).pipe(
          Effect.provide(schedulerLayer(plan.options.concurrency)),
          Effect.provide(openrouterClientLayer),
        ),
      );
    }),
  );
