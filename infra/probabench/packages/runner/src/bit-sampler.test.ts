import * as LanguageModel from "@effect/ai/LanguageModel";
import { describe, expect, it } from "@effect/vitest";
import { Probability } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { BitSampler } from "./bit-sampler";

const x = Schema.decodeSync(Probability)(0.5);

/** A LanguageModel whose every generation returns the same canned reply text. */
const fakeModel = (reply: string) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([{ type: "text", text: reply }]),
      streamText: () => Stream.empty,
    }),
  );

describe("BitSampler.sampleBit strict parse", () => {
  const cases = [
    { reply: "1", expected: 1 },
    { reply: "0", expected: 0 },
    { reply: " 1 ", expected: 1 },
    { reply: "banana", expected: { invalidText: "banana" } },
    { reply: "", expected: { invalidText: "" } },
  ] as const;

  for (const { reply, expected } of cases) {
    it.effect(`parses ${JSON.stringify(reply)} into ${JSON.stringify(expected)}`, () =>
      Effect.gen(function* () {
        const sampler = yield* BitSampler;
        const trial = yield* sampler.sampleBit(x);
        expect(trial).toEqual(expected);
      }).pipe(Effect.provide(Layer.merge(BitSampler.Default, fakeModel(reply)))),
    );
  }
});

import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/TestClock";

describe("BitSampler request lifetime", () => {
  it.effect("fails a stalled provider attempt after two minutes", () =>
    Effect.gen(function* () {
      const sampler = yield* BitSampler;
      const fiber = yield* Effect.fork(Effect.flip(sampler.sampleBit(x)));
      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe("LlmError");
      expect(error.cause._tag).toBe("TimeoutException");
    }).pipe(
      Effect.provide(
        Layer.merge(
          BitSampler.Default,
          Layer.effect(
            LanguageModel.LanguageModel,
            LanguageModel.make({
              generateText: () => Effect.never,
              streamText: () => Stream.empty,
            }),
          ),
        ),
      ),
    ),
  );
});
