// A benchmark plan: the resolved targets, sampling options and history file that
// the CLI prints, confirms and executes.
import { planBudget, type ReasoningMode } from "@probabench/domain";
import { isNonEmptyReadonlyArray, type NonEmptyReadonlyArray } from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type BenchTarget, selectTargets } from "./targets";

/** A rejected run request, raised before any credentials are read or samples drawn. */
export class InvalidOptions extends Data.TaggedError("InvalidOptions")<{
  readonly message: string;
}> {}

/** Validated by the CLI's flag schemas and prompt bounds; code past them trusts these numbers. */
export interface SamplingOptions {
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  /** Most samples in flight at once. */
  readonly concurrency: number;
  /** Output ceiling for targets that reason. */
  readonly maxTokens: number;
}

export interface BenchPlan {
  readonly targets: NonEmptyReadonlyArray<BenchTarget>;
  readonly options: SamplingOptions;
  /** History file each completed run is appended to. */
  readonly out: string;
}

export const MISSING_MODEL_MESSAGE =
  "Choose a model with --model vendor/model (or a listed alias). Run --list to see aliases, or run without --model in an interactive terminal for guided setup.";

export const resolvePlan = (request: {
  /** Tokens from splitModels. */
  readonly models: readonly string[];
  /** Overrides every target's reasoning mode. */
  readonly reasoning: ReasoningMode | undefined;
  readonly options: SamplingOptions;
  readonly out: string;
}): Effect.Effect<BenchPlan, InvalidOptions> => {
  const { targets, unknown } = selectTargets(request.models, request.reasoning);
  if (unknown.length > 0) {
    return Effect.fail(
      new InvalidOptions({
        message: `Unknown models: ${unknown.join(", ")}. Use --list or an OpenRouter model ID (vendor/model).`,
      }),
    );
  }
  if (!isNonEmptyReadonlyArray(targets)) {
    return Effect.fail(new InvalidOptions({ message: MISSING_MODEL_MESSAGE }));
  }
  return Effect.succeed({ targets, options: request.options, out: request.out });
};

export const describePlan = ({ targets, options }: BenchPlan): string => {
  const { samples, attempts } = planBudget(options, targets.length);
  return [
    `Targets (${targets.length}):`,
    ...targets.map((target) => `  ${target.id} · reasoning ${target.reasoning}`),
    `Projected samples: ${samples}`,
    `Provider attempts with retries: up to ${attempts}`,
  ].join("\n");
};
