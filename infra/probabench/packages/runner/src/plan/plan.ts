// A benchmark plan: the resolved model series, sampling options and history file
// that the CLI prints, confirms and executes.
import { planBudget, type ReasoningMode } from "@probabench/domain";
import { isNonEmptyReadonlyArray, type NonEmptyReadonlyArray } from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type ModelSeries, selectSeries } from "./series";

/** A rejected run request, raised before any credentials are read or samples drawn. */
export class InvalidOptions extends Data.TaggedError("InvalidOptions")<{
  readonly message: string;
}> {}

/** Validated by the CLI's flag schemas; code past them trusts these numbers. */
export interface SamplingOptions {
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  /** Most samples in flight at once. */
  readonly concurrency: number;
  /** Output ceiling for series that reason. */
  readonly maxTokens: number;
}

export interface BenchPlan {
  readonly series: NonEmptyReadonlyArray<ModelSeries>;
  readonly options: SamplingOptions;
  /** History file each completed run is appended to. */
  readonly out: string;
}

export const MISSING_MODEL_MESSAGE =
  "Choose a model with --model vendor/model (or a listed alias). Run --list to see aliases.";

export const resolvePlan = (request: {
  /** Tokens from splitModels. */
  readonly models: readonly string[];
  /** Overrides every series' reasoning mode. */
  readonly reasoning: ReasoningMode | undefined;
  readonly options: SamplingOptions;
  readonly out: string;
}): Effect.Effect<BenchPlan, InvalidOptions> => {
  const { series, unknown } = selectSeries(request.models, request.reasoning);
  if (unknown.length > 0) {
    return Effect.fail(
      new InvalidOptions({
        message: `Unknown models: ${unknown.join(", ")}. Use --list or an OpenRouter model ID (vendor/model).`,
      }),
    );
  }
  if (!isNonEmptyReadonlyArray(series)) {
    return Effect.fail(new InvalidOptions({ message: MISSING_MODEL_MESSAGE }));
  }
  return Effect.succeed({ series, options: request.options, out: request.out });
};

export const describePlan = ({ series, options }: BenchPlan): string => {
  const { samples } = planBudget(options, series.length);
  return [
    `Models (${series.length}):`,
    ...series.map((entry) => `  ${entry.modelSlug} · reasoning ${entry.reasoning}`),
    `Projected samples: ${samples}`,
  ].join("\n");
};
