import { describe, expect, it } from "@effect/vitest";
import { type Outcome, Probability } from "@probabench/domain";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/TestClock";
import type { SamplingOptions } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { SamplingProgress } from "../progress/observer";
import { OpenRouterClient } from "./openrouter";
import { schedulerLayer } from "./scheduler";
import { sweep } from "./sweep";

const series: ModelSeries = { model: "vendor/model", modelSlug: "vendor/model", reasoning: "off" };
/** One sample at 0% and one at 100%. */
const twoSamples: SamplingOptions = {
  trialsPerStep: 1,
  stepPercent: 100,
  concurrency: 1,
  maxTokens: 4096,
};

/** An endpoint whose every reply is the text `reply` produces. */
const fakeModel = (reply: () => Effect.Effect<string>) =>
  Layer.succeed(OpenRouterClient, { complete: () => Effect.suspend(reply) });

describe("sweep", () => {
  it.effect("attributes out-of-order answers to the probability requested", () =>
    Effect.gen(function* () {
      const releaseFirst = yield* Deferred.make<void>();
      const checkpointed = yield* Deferred.make<void>();
      let calls = 0;
      let active = 0;
      let saved = 0;
      const recorded: { x: number; outcome: Outcome }[] = [];
      const model = fakeModel(() =>
        ++calls === 1 ? Deferred.await(releaseFirst).pipe(Effect.as("0")) : Effect.succeed("1"),
      );
      const fiber = yield* Effect.fork(
        sweep(
          series,
          { ...twoSamples, concurrency: 2 },
          [
            { x: Probability.make(0), outcomes: [] },
            { x: Probability.make(1), outcomes: [] },
          ],
          (x, outcome) =>
            Effect.sync(() => {
              recorded.push({ x, outcome });
            }).pipe(Effect.andThen(Deferred.await(checkpointed))),
        ).pipe(
          Effect.provide(model),
          Effect.provideService(SamplingProgress, {
            ...SamplingProgress.defaultValue(),
            started: () => {
              active++;
            },
            ended: () => {
              active--;
            },
            saved: () => {
              saved++;
            },
          }),
        ),
      );
      yield* TestClock.adjust(0);
      expect(calls).toBe(2);
      expect(recorded).toEqual([{ x: 1, outcome: 1 }]);
      // A reply awaiting its durable checkpoint is neither an active HTTP call
      // nor saved progress. Its out-of-order completion must not inflate either.
      expect(active).toBe(1);
      expect(saved).toBe(0);
      yield* Deferred.succeed(checkpointed, undefined);
      yield* TestClock.adjust(0);
      expect(saved).toBe(1);
      yield* Deferred.succeed(releaseFirst, undefined);
      expect(yield* Fiber.join(fiber)).toBe(2);
      expect(active).toBe(0);
      expect(saved).toBe(2);
      expect(recorded).toEqual([
        { x: 1, outcome: 1 },
        { x: 0, outcome: 0 },
      ]);
    }).pipe(Effect.provide(schedulerLayer(2))),
  );
});
