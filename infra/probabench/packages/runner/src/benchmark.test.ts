import * as LanguageModel from "@effect/ai/LanguageModel";
import { describe, expect, it } from "@effect/vitest";
import { Probability, rmse, type Trial } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Benchmark } from "./benchmark";
import { BitSampler } from "./bit-sampler";

/** A LanguageModel present only to satisfy BitSampler's static requirement; the fake sampler never invokes it. */
const unusedModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([{ type: "text", text: "" }]),
    streamText: () => Stream.empty,
  }),
);

/** A BitSampler whose every sample returns the same canned bit, ignoring x and the model. */
const fakeSampler = (bit: Trial) =>
  Layer.succeed(BitSampler, BitSampler.make({ sampleBit: () => Effect.succeed(bit) }));

describe("Benchmark.run sweep", () => {
  it.effect("sweeps the X grid into a Run with metric-derived points", () =>
    Effect.gen(function* () {
      const benchmark = yield* Benchmark;
      const run = yield* benchmark.run({
        model: "claude-haiku-4.5",
        trialsPerStep: 4,
        stepPercent: 50,
        concurrency: 2,
      });

      const expectedX = [0, 0.5, 1].map((fraction) => Probability.make(fraction));
      const expectedOutcomes: ReadonlyArray<Trial> = [1, 1, 1, 1];

      expect(run.points.length).toBe(expectedX.length);
      run.points.forEach((point, index) => {
        expect(point.x).toBe(expectedX[index]);
        expect(point.outcomes).toEqual(expectedOutcomes);
        const expectedProbability = expectedX[index];
        if (expectedProbability === undefined)
          throw new Error("Unexpected extra probability point");
        expect(point.rmse).toBe(rmse(expectedOutcomes, expectedProbability));
      });

      expect(run.model).toBe("claude-haiku-4.5");
      expect(run.trialsPerStep).toBe(4);
      expect(run.stepPercent).toBe(50);
      expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }).pipe(Effect.provide(Layer.mergeAll(Benchmark.Default, fakeSampler(1), unusedModel))),
  );
});

describe("Benchmark.run validation and concurrency", () => {
  it.effect(
    "includes the 100% endpoint for a non-divisor step and bounds concurrent samples",
    () => {
      let active = 0;
      let maximum = 0;
      let calls = 0;
      const sampler = Layer.succeed(
        BitSampler,
        BitSampler.make({
          sampleBit: () =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                calls++;
                active++;
                maximum = Math.max(maximum, active);
              }),
              () => Effect.yieldNow().pipe(Effect.as(1 as const)),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
        }),
      );
      return Effect.gen(function* () {
        const benchmark = yield* Benchmark;
        const run = yield* benchmark.run({
          model: "test",
          trialsPerStep: 5,
          stepPercent: 30,
          concurrency: 2,
        });
        expect(run.points.map((point) => point.x)).toEqual([0, 0.3, 0.6, 0.9, 1]);
        expect(calls).toBe(25);
        expect(maximum).toBe(2);
        expect(active).toBe(0);
      }).pipe(Effect.provide(Layer.mergeAll(Benchmark.Default, sampler, unusedModel)));
    },
  );

  for (const invalid of [
    { stepPercent: 0 },
    { stepPercent: -10 },
    { stepPercent: 101 },
    { stepPercent: Number.NaN },
    { trialsPerStep: 0 },
    { trialsPerStep: 1.5 },
    { concurrency: 0 },
    { concurrency: Infinity },
  ]) {
    it.effect(`rejects invalid sampling config ${JSON.stringify(invalid)} before sampling`, () =>
      Effect.gen(function* () {
        const benchmark = yield* Benchmark;
        const error = yield* Effect.flip(
          benchmark.run({
            model: "test",
            trialsPerStep: 1,
            stepPercent: 10,
            concurrency: 1,
            ...invalid,
          }),
        );
        expect(error._tag).toBe("InvalidOptions");
      }).pipe(Effect.provide(Layer.mergeAll(Benchmark.Default, fakeSampler(1), unusedModel))),
    );
  }
});
