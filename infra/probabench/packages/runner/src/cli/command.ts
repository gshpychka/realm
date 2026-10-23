// The probabench command: flags, then the plan, its confirmation and its execution.
import { fileURLToPath } from "node:url";
import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import * as Prompt from "@effect/cli/Prompt";
import {
  DEFAULT_PRESET,
  RESULTS_FILE,
  ReasoningMode,
  StepPercent,
  TrialsPerStep,
} from "@probabench/domain";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describePlan, InvalidOptions, resolvePlan, type SamplingOptions } from "../plan/plan";
import { ALL_ALIASES, describeAliases, splitModels } from "../plan/series";
import { executePlan } from "./execute";

/**
 * The workspace's history file, which the web app serves at its site root. Resolved
 * from this file rather than the working directory; command.test.ts checks that it
 * exists.
 */
export const HISTORY_PATH = fileURLToPath(
  new URL(`../../../../data/${RESULTS_FILE}`, import.meta.url),
);

const DEFAULTS: SamplingOptions = {
  trialsPerStep: DEFAULT_PRESET.trialsPerStep,
  stepPercent: DEFAULT_PRESET.stepPercent,
  concurrency: 10,
  maxTokens: 4096,
};

export const NON_TTY_MESSAGE =
  "Refusing to run without confirmation: stdin is not a TTY. Re-run with --yes to proceed non-interactively.";

const PositiveInt = Schema.Int.pipe(Schema.positive());

/** An integer flag whose out-of-range error names the flag. */
const integerFlag = (name: string, schema: Schema.Schema<number>, expected: string) =>
  Options.integer(name).pipe(
    Options.withSchema(
      schema.annotations({ message: () => `--${name} must be ${expected}.`, override: true }),
    ),
  );

const options = {
  model: Options.text("model").pipe(
    Options.withAlias("m"),
    Options.optional,
    Options.withDescription(
      `Comma-separated OpenRouter model IDs (vendor/model) or aliases; "${ALL_ALIASES}" selects every alias.`,
    ),
  ),
  trials: integerFlag("trials", TrialsPerStep, "a positive integer").pipe(
    Options.withDefault(DEFAULTS.trialsPerStep),
    Options.withDescription(`Samples per target (default: ${DEFAULTS.trialsPerStep}).`),
  ),
  step: integerFlag("step", StepPercent, "from 1 to 100").pipe(
    Options.withDefault(DEFAULTS.stepPercent),
    Options.withDescription(
      `Target step from 1 to 100 percent (default: ${DEFAULTS.stepPercent}).`,
    ),
  ),
  maxTokens: integerFlag("max-tokens", PositiveInt, "a positive integer").pipe(
    Options.withDefault(DEFAULTS.maxTokens),
    Options.withDescription(
      `Output ceiling for reasoning models (default: ${DEFAULTS.maxTokens}).`,
    ),
  ),
  concurrency: integerFlag("concurrency", PositiveInt, "a positive integer").pipe(
    Options.withDefault(DEFAULTS.concurrency),
    Options.withDescription(`Maximum simultaneous samples (default: ${DEFAULTS.concurrency}).`),
  ),
  reasoning: Options.choice("reasoning", ReasoningMode.literals).pipe(
    Options.optional,
    Options.withDescription(
      "Override reasoning mode (model IDs default to off; aliases keep their own).",
    ),
  ),
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
};

export const benchCommand = Command.make("probabench", options, (flags) =>
  Effect.gen(function* () {
    if (flags.list) return yield* Console.log(describeAliases());
    const plan = yield* resolvePlan({
      models: splitModels(Option.getOrElse(flags.model, () => "")),
      reasoning: Option.getOrUndefined(flags.reasoning),
      options: {
        trialsPerStep: flags.trials,
        stepPercent: flags.step,
        concurrency: flags.concurrency,
        maxTokens: flags.maxTokens,
      },
      out: HISTORY_PATH,
    });
    yield* Console.log(describePlan(plan));
    if (flags.dryRun) return;
    if (!flags.yes) {
      // The prompt reads its answer from stdin, which the dev server's runner lacks.
      if (process.stdin.isTTY !== true)
        return yield* new InvalidOptions({ message: NON_TTY_MESSAGE });
      // Ctrl-C at the prompt quits it, which answers no.
      const confirmed = yield* Prompt.confirm({ message: "Run this plan?", initial: false }).pipe(
        Effect.catchTag("QuitException", () => Effect.succeed(false)),
      );
      if (!confirmed) return yield* Console.log("Aborted.");
    }
    yield* executePlan(plan);
  }),
);
