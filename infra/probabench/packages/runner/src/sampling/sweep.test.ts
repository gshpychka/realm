import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/TestClock";
import type { SamplingOptions } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
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
      let calls = 0;
      const model = fakeModel(() =>
        ++calls === 1 ? Deferred.await(releaseFirst).pipe(Effect.as("0")) : Effect.succeed("1"),
      );
      const fiber = yield* Effect.fork(
        sweep(series, { ...twoSamples, concurrency: 2 }).pipe(Effect.provide(model)),
      );
      yield* TestClock.adjust(0);
      expect(calls).toBe(2);
      yield* Deferred.succeed(releaseFirst, undefined);
      const run = yield* Fiber.join(fiber);
      expect(run.points).toEqual([
        { x: 0, outcomes: [0] },
        { x: 1, outcomes: [1] },
      ]);
    }).pipe(Effect.provide(schedulerLayer(2))),
  );
});
