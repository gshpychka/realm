import type * as LanguageModel from "@effect/ai/LanguageModel";
import type * as HttpClient from "@effect/platform/HttpClient";
import { type Run, summarizeRun } from "@probabench/domain";
import type * as ConfigError from "effect/ConfigError";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Benchmark } from "./benchmark";
import { BitSampler, type LlmError } from "./bit-sampler";
import { openrouterApiKey, openrouterClientLayer, openrouterModelLayer } from "./openrouter";
import { type BenchPlan, InvalidOptions, type SamplingOptions } from "./plan";
import type { BenchTarget } from "./registry";
import { ResultsStore, type ResultsStoreError } from "./results-store";
import { withProviderRetry } from "./retry";

export const retryingBitSampler: Layer.Layer<BitSampler> = Layer.effect(
  BitSampler,
  Effect.map(BitSampler, (base) =>
    BitSampler.make({ sampleBit: (x) => withProviderRetry(base.sampleBit(x)) }),
  ),
).pipe(Layer.provide(BitSampler.Default));

export const sweepTarget = <RClient>(
  target: BenchTarget,
  options: SamplingOptions,
  modelLayer: Layer.Layer<LanguageModel.LanguageModel, never, RClient>,
): Effect.Effect<Run, LlmError, Benchmark | RClient> =>
  Benchmark.pipe(
    Effect.flatMap((benchmark) =>
      benchmark.run({
        model: target.id,
        modelSlug: target.slug,
        reasoning: target.reasoning,
        trialsPerStep: options.trialsPerStep,
        stepPercent: options.stepPercent,
        concurrency: options.concurrency,
      }),
    ),
    Effect.provide(Layer.merge(retryingBitSampler, modelLayer)),
  );

export const describeCompletedRun = (run: Run, out: string): string => {
  const { valid, total, meanCalibrationError } = summarizeRun(run);
  const gap =
    meanCalibrationError === null ? "n/a" : `${(meanCalibrationError * 100).toFixed(1)} pp`;
  return (
    `[${run.model}] run ${run.id} complete: ${valid}/${total} valid, ` +
    `mean calibration gap ${gap} → saved to ${out}`
  );
};

/** Save each completed target immediately; a later failure leaves these runs available. */
export const sweepAll = <R, E>(
  targets: readonly BenchTarget[],
  out: string,
  sweep: (target: BenchTarget) => Effect.Effect<Run, E, R>,
): Effect.Effect<void, E | ResultsStoreError, R | ResultsStore> =>
  Effect.gen(function* () {
    const store = yield* ResultsStore;
    yield* store.prepare(out);
    yield* Effect.forEach(
      targets,
      (target) =>
        Effect.gen(function* () {
          yield* Console.log(`[${target.id}] starting sweep`);
          const run = yield* sweep(target);
          yield* store.append(out, run);
          yield* Console.log(describeCompletedRun(run, out));
        }),
      { discard: true },
    );
  });

/** Preflight credentials and persistence before starting paid requests. */
export const executePlan = (
  plan: BenchPlan,
): Effect.Effect<
  void,
  LlmError | InvalidOptions | ResultsStoreError | ConfigError.ConfigError,
  Benchmark | ResultsStore | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    yield* openrouterApiKey.pipe(
      Effect.mapError(
        () =>
          new InvalidOptions({
            message:
              "Set OPENROUTER_API_KEY in .env.local (in the ProbaBench directory), or export it in your shell, then retry.",
          }),
      ),
    );
    yield* sweepAll(plan.targets, plan.out, (target) =>
      sweepTarget(target, plan.options, openrouterModelLayer(target, plan.options.maxTokens)),
    ).pipe(Effect.provide(openrouterClientLayer));
  });
