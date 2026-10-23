import { fileURLToPath } from "node:url";
import * as Command from "@effect/cli/Command";
import * as HelpDoc from "@effect/cli/HelpDoc";
import * as Span from "@effect/cli/HelpDoc/Span";
import * as Options from "@effect/cli/Options";
import * as Prompt from "@effect/cli/Prompt";
import {
  MODEL_ALIASES,
  type PlanBudget,
  planBudget,
  REASONING_LABELS,
  ReasoningMode,
  SAMPLING_PRESETS,
  type SamplingPreset,
} from "@probabench/domain";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { InvalidOptions, positiveInteger, probabilityStep } from "./options";
import { type BenchTarget, describeAliases, modelLabel, selectTargets } from "./registry";
import { executePlan } from "./run";

/**
 * The web app's published history, which Vite serves at /data/results.json. Resolved
 * from this file rather than the working directory.
 */
export const DEFAULT_OUT = fileURLToPath(
  new URL("../../web/public/data/results.json", import.meta.url),
);
export const NON_TTY_MESSAGE =
  "Refusing to run without confirmation: stdin is not a TTY. Re-run with --yes to proceed non-interactively.";
export const MISSING_MODEL_MESSAGE =
  "Choose a model with --model vendor/model (or a listed alias). Run --list to see aliases, or run bun run bench in an interactive terminal for guided setup.";

export class NonInteractiveError extends Data.TaggedError("NonInteractiveError")<{
  readonly message: string;
}> {}

export interface BenchPlan {
  readonly targets: readonly BenchTarget[];
  readonly unknown: readonly string[];
  readonly budget: PlanBudget;
}

/** Pure resolution shared by guided setup, explicit CLI runs, and local integrations. */
export const resolvePlan = (
  modelTokens: readonly string[],
  trialsPerStep: number,
  stepPercent: number,
  reasoning?: ReasoningMode,
): BenchPlan => {
  positiveInteger(trialsPerStep, "trials");
  probabilityStep(stepPercent);
  const { targets, unknown } = selectTargets(modelTokens, reasoning);
  const budget = planBudget({ trialsPerStep, stepPercent }, targets.length);
  if (targets.length > 0) positiveInteger(budget.attempts, "maximum provider attempt count");
  return { targets, unknown, budget };
};

export const describePlan = (plan: BenchPlan): string =>
  [
    ...(plan.unknown.length === 0 ? [] : [`Unknown models: ${plan.unknown.join(", ")}`]),
    `Targets (${plan.targets.length}):`,
    ...plan.targets.map((target) => `  ${target.id} · reasoning ${target.reasoning}`),
    `Projected samples: ${plan.budget.samples}`,
    `Provider attempts with retries: up to ${plan.budget.attempts}`,
  ].join("\n");

export const confirmationGate = (
  yes: boolean,
  isInteractive: boolean,
): Effect.Effect<"proceed" | "prompt", NonInteractiveError> =>
  yes
    ? Effect.succeed("proceed")
    : isInteractive
      ? Effect.succeed("prompt")
      : Effect.fail(new NonInteractiveError({ message: NON_TTY_MESSAGE }));

export const validatePlan = (plan: BenchPlan): Effect.Effect<void, InvalidOptions> =>
  plan.unknown.length > 0
    ? Effect.fail(
        new InvalidOptions({
          message: `Unknown models: ${plan.unknown.join(", ")}. Use --list or a vendor/model slug.`,
        }),
      )
    : plan.targets.length === 0
      ? Effect.fail(new InvalidOptions({ message: MISSING_MODEL_MESSAGE }))
      : Effect.void;

const splitTokens = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
const optionError = (error: unknown) =>
  HelpDoc.p(Span.text(error instanceof Error ? error.message : String(error)));
const integerOption = (name: string, defaultValue: number) =>
  Options.integer(name).pipe(
    Options.withDefault(defaultValue),
    Options.mapTryCatch(
      (value) => (name === "step" ? probabilityStep(value) : positiveInteger(value, name)),
      optionError,
    ),
  );

export const TRIAL_PRESETS: ReadonlyArray<Prompt.Prompt.SelectChoice<SamplingPreset | "custom">> = [
  ...SAMPLING_PRESETS.map((preset) => {
    const { points, samples } = planBudget(preset);
    return {
      title: `${preset.label} — ${preset.trialsPerStep} trials × ${points} points (${preset.stepPercent}% step): ${samples.toLocaleString("en")} samples per model`,
      value: preset,
    };
  }),
  { title: "Custom trial count and probability step", value: "custom" },
];

/** No network access: choose aliases or enter any OpenRouter vendor/model slug. */
export const promptRunSetup = Effect.gen(function* () {
  const selected = yield* Prompt.select({
    message: "Choose a model",
    choices: [
      ...MODEL_ALIASES.map((model) => ({
        title: `${model.alias} · ${modelLabel(model.slug, model.reasoning ?? "off")}`,
        value: model.alias,
      })),
      { title: "Enter another OpenRouter model", value: "custom" },
      { title: "Run every alias", value: "all" },
    ],
  });
  const models =
    selected === "custom"
      ? splitTokens(
          yield* Prompt.text({
            message: "OpenRouter vendor/model slug (comma-separated for several)",
            validate: (raw) => {
              const selection = selectTargets(splitTokens(raw));
              return selection.targets.length > 0 && selection.unknown.length === 0
                ? Effect.succeed(raw)
                : Effect.fail("Enter a listed alias or an OpenRouter vendor/model slug.");
            },
          }),
        )
      : [selected];
  const preset = yield* Prompt.select({ message: "Benchmark size", choices: TRIAL_PRESETS });
  const { trialsPerStep, stepPercent } =
    preset === "custom"
      ? {
          trialsPerStep: yield* Prompt.integer({
            message: "Samples at each probability",
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
          stepPercent: yield* Prompt.integer({
            message: "Probability step (percent)",
            min: 1,
            max: 100,
          }),
        }
      : preset;
  const reasoning =
    selected === "custom"
      ? yield* Prompt.select({
          message: "Reasoning mode",
          choices: ReasoningMode.literals.map((value) => ({
            title: REASONING_LABELS[value],
            value,
          })),
        })
      : undefined;
  return { models, trialsPerStep, stepPercent, reasoning };
});

const modelOption = Options.text("model").pipe(
  Options.withAlias("m"),
  Options.withDefault(""),
  Options.withDescription(
    'Comma-separated OpenRouter vendor/model slugs or aliases; "all" selects every alias.',
  ),
);
const reasoningOption = Options.choice("reasoning", ReasoningMode.literals).pipe(
  Options.optional,
  Options.withDescription(
    "Override reasoning mode (slugs default to off; aliases retain their named mode).",
  ),
);
const outOption = Options.text("out").pipe(
  Options.withDefault(DEFAULT_OUT),
  Options.withDescription("History file (default: the web app's public/data/results.json)."),
  Options.mapTryCatch((out) => {
    if (!out.trim()) throw new InvalidOptions({ message: "out must be a nonempty file path." });
    return out;
  }, optionError),
);

export const benchCommand = Command.make(
  "probabench",
  {
    model: modelOption,
    trials: Options.integer("trials").pipe(
      Options.mapTryCatch((value) => positiveInteger(value, "trials"), optionError),
      Options.optional,
      Options.withDescription(
        "Samples per probability (default: 100; guided setup offers presets).",
      ),
    ),
    step: Options.integer("step").pipe(
      Options.mapTryCatch(probabilityStep, optionError),
      Options.optional,
      Options.withDescription("Probability step from 1 to 100 percent (default: 10)."),
    ),
    maxTokens: integerOption("max-tokens", 4096).pipe(
      Options.withDescription("Output ceiling for reasoning models (default: 4096)."),
    ),
    concurrency: integerOption("concurrency", 10).pipe(
      Options.withDescription("Maximum simultaneous samples (default: 10)."),
    ),
    reasoning: reasoningOption,
    out: outOption,
    yes: Options.boolean("yes").pipe(
      Options.withAlias("y"),
      Options.withDescription("Skip final confirmation."),
    ),
    dryRun: Options.boolean("dry-run").pipe(
      Options.withDescription("Print and validate the plan without credentials or provider calls."),
    ),
    list: Options.boolean("list").pipe(
      Options.withDescription("List model aliases and exit without credentials."),
    ),
  },
  (opts) =>
    Effect.gen(function* () {
      if (opts.list) {
        yield* Console.log(describeAliases());
        return;
      }
      const interactive = process.stdin.isTTY === true;
      const explicitModels = splitTokens(opts.model);
      if (explicitModels.length === 0 && !interactive) {
        return yield* Effect.fail(new InvalidOptions({ message: MISSING_MODEL_MESSAGE }));
      }
      const guided = explicitModels.length === 0 ? yield* promptRunSetup : undefined;
      const trialsPerStep = Option.getOrUndefined(opts.trials) ?? guided?.trialsPerStep ?? 100;
      const stepPercent = Option.getOrUndefined(opts.step) ?? guided?.stepPercent ?? 10;
      const reasoning = Option.getOrUndefined(opts.reasoning) ?? guided?.reasoning;
      const plan = yield* Effect.try({
        try: () =>
          resolvePlan(guided?.models ?? explicitModels, trialsPerStep, stepPercent, reasoning),
        catch: (error) =>
          error instanceof InvalidOptions ? error : new InvalidOptions({ message: String(error) }),
      });
      yield* Console.log(describePlan(plan));
      yield* validatePlan(plan);
      if (opts.dryRun) return;
      const gate = yield* confirmationGate(opts.yes, interactive);
      const confirmed =
        gate === "proceed" ||
        (yield* Prompt.confirm({ message: "Run this plan?", initial: false }));
      if (!confirmed) {
        yield* Console.log("Aborted.");
        return;
      }
      yield* executePlan(plan.targets, opts.out, {
        trialsPerStep,
        stepPercent,
        maxTokens: opts.maxTokens,
        concurrency: opts.concurrency,
      });
    }),
);
