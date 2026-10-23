// Benchmark orchestrates a single benchmark-target calibration sweep into a Run:
// it walks the probability grid, takes trialsPerStep samples at each X via the
// BitSampler, and collects the outcomes into Points.
// It stays target-agnostic — the caller layers the target-specific LanguageModel
// around the returned Effect, the same way BitSampler does.

import { randomUUID } from "node:crypto";
import type * as LanguageModel from "@effect/ai/LanguageModel";
import { counts, type Point, Probability, type Run } from "@probabench/domain";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { BitSampler, type LlmError } from "./bit-sampler";
import { type InvalidOptions, probabilityPercentages, validateSamplingOptions } from "./options";

/** A single target sweep request: the Run's series id and the grid/concurrency shape. */
export interface BenchmarkConfig {
  readonly model: string;
  readonly modelSlug?: string;
  readonly reasoning?: string;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
}

export interface PointProgress {
  readonly model: string;
  readonly point: Point;
  readonly completedPoints: number;
  readonly totalPoints: number;
}

/** Human-readable progress shared by the CLI and local integrations. */
export const describePointProgress = ({
  model,
  point,
  completedPoints,
  totalPoints,
}: PointProgress): string => {
  const tally = counts(point.outcomes);
  return (
    `[${model}] point ${completedPoints}/${totalPoints} x=${Math.round(point.x * 100)}% → ` +
    `ones=${tally.ones} zeros=${tally.zeros} invalid=${tally.invalid}`
  );
};

/** The probability grid {0, step, …, 100}% as fractions in [0, 1]. */
const probabilityGrid = (stepPercent: number): ReadonlyArray<Probability> => {
  return probabilityPercentages(stepPercent).map((percent) => Probability.make(percent / 100));
};

/**
 * Sweeps the probability grid for one target: at each X it draws trialsPerStep
 * samples (up to `concurrency` in flight) into a Point, stamping the Run's start
 * time from the Clock.
 */
const run = (
  config: BenchmarkConfig,
): Effect.Effect<Run, LlmError | InvalidOptions, BitSampler | LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    yield* validateSamplingOptions(config);
    const sampler = yield* BitSampler;
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const grid = probabilityGrid(config.stepPercent);
    const points = yield* Effect.forEach(grid, (x, index) =>
      Effect.forEach(
        Array.from({ length: config.trialsPerStep }, (_, index) => index),
        () => sampler.sampleBit(x),
        { concurrency: config.concurrency },
      ).pipe(
        Effect.map((outcomes): Point => ({ x, outcomes })),
        Effect.tap((point) =>
          Console.log(
            describePointProgress({
              model: config.model,
              point,
              completedPoints: index + 1,
              totalPoints: grid.length,
            }),
          ),
        ),
      ),
    );
    return {
      id: randomUUID(),
      model: config.model,
      ...(config.modelSlug === undefined ? {} : { modelSlug: config.modelSlug }),
      ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }),
      trialsPerStep: config.trialsPerStep,
      stepPercent: config.stepPercent,
      startedAt,
      points,
    };
  });

/** Runs a benchmark-target calibration sweep, requiring a BitSampler (and the model layer it samples through). */
export class Benchmark extends Effect.Service<Benchmark>()("Benchmark", {
  sync: () => ({ run }),
}) {}
