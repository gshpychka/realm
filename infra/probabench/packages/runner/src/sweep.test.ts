import * as LanguageModel from "@effect/ai/LanguageModel";
import { describe, expect, it } from "@effect/vitest";
import { MAX_RETRIES } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/TestClock";
import type { SamplingOptions } from "./plan";
import type { BenchTarget } from "./registry";
import { sweep } from "./sweep";

const target: BenchTarget = { id: "vendor/model", slug: "vendor/model", reasoning: "off" };
/** One sample at 0% and one at 100%. */
const twoSamples: SamplingOptions = {
  trialsPerStep: 1,
  stepPercent: 100,
  concurrency: 1,
  maxTokens: 16,
};

/** A LanguageModel whose every reply is the text `reply` produces. */
const fakeModel = (reply: () => Effect.Effect<string>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.map(reply(), (text) => [{ type: "text", text }]),
      streamText: () => Stream.empty,
    }),
  );

describe("sweep", () => {
  it.effect("samples every grid point, both endpoints included, at bounded concurrency", () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const model = fakeModel(() =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          calls++;
          active++;
          maximum = Math.max(maximum, active);
        }),
        () => Effect.yieldNow().pipe(Effect.as("1")),
        () =>
          Effect.sync(() => {
            active--;
          }),
      ),
    );
    return Effect.gen(function* () {
      const run = yield* sweep(target, {
        trialsPerStep: 5,
        stepPercent: 30,
        concurrency: 2,
        maxTokens: 16,
      }).pipe(Effect.provide(model));
      expect(run).toMatchObject({
        model: target.id,
        modelSlug: target.slug,
        reasoning: "off",
        trialsPerStep: 5,
        stepPercent: 30,
        startedAt: new Date(0).toISOString(),
      });
      expect(run.points).toEqual(
        [0, 0.3, 0.6, 0.9, 1].map((x) => ({ x, outcomes: [1, 1, 1, 1, 1] })),
      );
      expect(calls).toBe(25);
      expect(maximum).toBe(2);
      expect(active).toBe(0);
    });
  });

  for (const [reply, outcome] of [
    ["1", 1],
    ["0", 0],
    [" 1\n", 1],
    ["banana", { invalidText: "banana" }],
    ["", { invalidText: "" }],
  ] as const) {
    it.effect(`records the reply ${JSON.stringify(reply)} as ${JSON.stringify(outcome)}`, () =>
      Effect.gen(function* () {
        const run = yield* sweep(target, twoSamples).pipe(
          Effect.provide(fakeModel(() => Effect.succeed(reply))),
        );
        expect(run.points.map((point) => point.outcomes)).toEqual([[outcome], [outcome]]);
      }),
    );
  }

  it.effect("fails once every attempt at a stalled sample has timed out", () => {
    let attempts = 0;
    const stalled = fakeModel(() =>
      Effect.sync(() => {
        attempts++;
      }).pipe(Effect.andThen(Effect.never)),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.flip(sweep(target, twoSamples)));
      yield* TestClock.adjust("15 minutes");
      const error = yield* Fiber.join(fiber);
      expect(error.cause._tag).toBe("TimeoutException");
      expect(attempts).toBe(MAX_RETRIES + 1);
    }).pipe(Effect.provide(stalled));
  });
});
