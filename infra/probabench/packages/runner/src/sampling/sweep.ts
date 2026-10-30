// Fill missing daily trial slots, checkpointing each answer before reporting progress.
import type { Outcome, Point, Probability } from "@probabench/domain";
import * as Effect from "effect/Effect";
import type { SamplingOptions } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { SamplingProgress } from "../progress/observer";
import { OpenRouterClient } from "./openrouter";
import { samplingMessages } from "./request";
import { type ProviderFailure, withProviderRetry } from "./retry";
import { RequestScheduler } from "./scheduler";

const ATTEMPT_TIMEOUT = "2 minutes";

const parseOutcome = (reply: string): Outcome => {
  const trimmed = reply.trim();
  if (trimmed === "1") return 1;
  if (trimmed === "0") return 0;
  return { invalidText: reply };
};

export const sweep = <E, R>(
  series: ModelSeries,
  options: SamplingOptions,
  saved: readonly Point[],
  save: (x: Probability, outcome: Outcome) => Effect.Effect<void, E, R>,
): Effect.Effect<number, ProviderFailure | E, OpenRouterClient | RequestScheduler | R> =>
  Effect.gen(function* () {
    const client = yield* OpenRouterClient;
    const scheduler = yield* RequestScheduler;
    const progress = yield* SamplingProgress;
    const points = saved;
    const existing = points.map((point) => point.outcomes.length);
    let collected = 0;

    function* samples() {
      for (let trial = 0; trial < options.trialsPerStep; trial++) {
        for (let target = 0; target < points.length; target++) {
          if (trial >= (existing[target] ?? 0)) yield target;
        }
      }
    }
    yield* Effect.forEach(
      samples(),
      (target) => {
        const point = points[target];
        if (!point) return Effect.dieMessage("Missing sampling target");
        let attempts = 0;
        const attempt = Effect.acquireUseRelease(
          Effect.sync(() => progress.started(series.model, attempts++ > 0)),
          () =>
            client
              .complete(series, options.maxTokens, samplingMessages(point.x))
              .pipe(Effect.timeout(ATTEMPT_TIMEOUT)),
          () => Effect.sync(() => progress.ended(series.model)),
        );
        // Once a reply arrives, commit it before honoring cancellation. The network
        // request and its retries remain interruptible and hold no storage lock.
        return Effect.uninterruptibleMask((restore) =>
          restore(scheduler.request(series.modelSlug, attempt).pipe(withProviderRetry)).pipe(
            Effect.flatMap((reply) => {
              progress.received(series.model, reply.cost);
              const outcome = parseOutcome(reply.text);
              return save(point.x, outcome).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    collected++;
                    progress.saved(series.model, typeof outcome !== "number");
                    return Effect.void;
                  }),
                ),
              );
            }),
          ),
        );
      },
      { concurrency: options.concurrency, discard: true },
    );
    return collected;
  });
