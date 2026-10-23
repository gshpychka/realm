// Benchmark orchestrates a single benchmark-target calibration sweep into a Run:
// it walks the probability grid, takes trialsPerStep samples at each X via the
// BitSampler, and collects the outcomes into Points.
// It stays target-agnostic — the caller layers the target-specific LanguageModel
// around the returned Effect, the same way BitSampler does.

import { randomUUID } from "node:crypto";
import type * as LanguageModel from "@effect/ai/LanguageModel";
import {
  formatPointProgress,
  type Point,
  probabilityGrid,
  type ReasoningMode,
  type Run,
} from "@probabench/domain";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { BitSampler, type LlmError } from "./bit-sampler";

/** A single target sweep request: the Run's series id and the grid/concurrency shape. */
export interface BenchmarkConfig {
  readonly model: string;
  readonly modelSlug: string;
  readonly reasoning: ReasoningMode;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
}

/**
 * Sweeps the probability grid for one target: at each X it draws trialsPerStep
 * samples (up to `concurrency` in flight) into a Point, stamping the Run's start
 * time from the Clock.
 */
const run = (
  config: BenchmarkConfig,
): Effect.Effect<Run, LlmError, BitSampler | LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
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
            formatPointProgress({
              model: config.model,
              point,
              completed: index + 1,
              total: grid.length,
            }),
          ),
        ),
      ),
    );
    return {
      id: randomUUID(),
      model: config.model,
      modelSlug: config.modelSlug,
      reasoning: config.reasoning,
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
