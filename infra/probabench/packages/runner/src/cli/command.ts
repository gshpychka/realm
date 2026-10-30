// The probabench command: flags, then the plan, its confirmation and its execution.
import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import * as Prompt from "@effect/cli/Prompt";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PRESET,
  ReasoningMode,
  StepPercent,
  TrialsPerStep,
} from "@probabench/domain";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { estimateCost } from "../plan/cost";
import { planDaily } from "../plan/daily";
import { InvalidOptions, resolvePlan, type SamplingOptions } from "../plan/plan";
import { ALL_ALIASES, describeAliases, splitModels } from "../plan/series";
import { DEFAULT_MAX_TOKENS } from "../sampling/request";
import { HISTORY_PATH, readSharedHistory, withSharedHistory } from "../store/results-store";
import { describeBriefing } from "./briefing";
import { executePlan } from "./execute";

const DEFAULTS: SamplingOptions = {
  trialsPerStep: DEFAULT_PRESET.trialsPerStep,
  stepPercent: DEFAULT_PRESET.stepPercent,
  concurrency: DEFAULT_CONCURRENCY,
  maxTokens: DEFAULT_MAX_TOKENS,
};

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
      `Comma-separated OpenRouter model IDs (vendor/model) or saved names; "${ALL_ALIASES}" selects every saved model.`,
    ),
  ),
  trials: integerFlag("trials", TrialsPerStep, "a positive integer").pipe(
    Options.withDefault(DEFAULTS.trialsPerStep),
    Options.withDescription(
      `Desired samples per probability today (default: ${DEFAULTS.trialsPerStep}).`,
    ),
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
      `Output ceiling when reasoning is on (default: ${DEFAULTS.maxTokens}).`,
    ),
  ),
  concurrency: integerFlag("concurrency", PositiveInt, "a positive integer").pipe(
    Options.withDefault(DEFAULTS.concurrency),
    Options.withDescription(
      `Global request ceiling; concurrency adjusts to rate limits (default: ${DEFAULTS.concurrency}).`,
    ),
  ),
  reasoning: Options.choice("reasoning", ReasoningMode.literals).pipe(
    Options.optional,
    Options.withDescription(
      "Override reasoning mode (model IDs default to off; saved names keep their setting).",
    ),
  ),
  yes: Options.boolean("yes").pipe(
    Options.withAlias("y"),
    Options.withDescription("Skip final confirmation."),
  ),
  dryRun: Options.boolean("dry-run").pipe(
    Options.withDescription(
      "Show the plan and live API cost estimate without credentials or sampling.",
    ),
  ),
  list: Options.boolean("list").pipe(
    Options.withDescription("List saved models and their reasoning settings without credentials."),
  ),
  sync: Options.boolean("sync").pipe(
    Options.withDescription("Upload local results and download shared history without sampling."),
  ),
};

const benchCommand = Command.make("probabench", options, (flags) =>
  Effect.gen(function* () {
    if (flags.list) return yield* Console.log(describeAliases());
    if (flags.sync)
      return yield* withSharedHistory(HISTORY_PATH, (history) =>
        Console.log(
          `History synchronized: ${history.runs.reduce((total, record) => total + record.points.reduce((count, point) => count + point.outcomes.length, 0), 0).toLocaleString()} samples.`,
        ),
      );
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
    const daily = planDaily(
      plan,
      yield* readSharedHistory(plan.out),
      new Date(yield* Clock.currentTimeMillis).toISOString(),
    );
    const estimate = yield* estimateCost(daily, plan.options);
    yield* Console.log(describeBriefing(plan, daily, estimate, process.stdout.columns || 80));
    if (flags.dryRun) return;
    if (daily.remaining > 0 && !flags.yes) {
      // The prompt needs a terminal on stdin; the dev bridge spawns the CLI with stdin ignored.
      if (process.stdin.isTTY !== true) {
        return yield* new InvalidOptions({
          message:
            "Refusing to run without confirmation: stdin is not a TTY. Re-run with --yes to proceed non-interactively.",
        });
      }
      // Ctrl-C at the prompt quits it, which answers no.
      const confirmed = yield* Prompt.confirm({ message: "Start sampling?", initial: false }).pipe(
        Effect.catchTag("QuitException", () => Effect.succeed(false)),
      );
      if (!confirmed) return yield* Console.log("Aborted.");
    }
    yield* executePlan(plan);
  }),
);

/** The CLI over process.argv-style arguments: the runtime, the script, then the flags. */
export const cli = Command.run(benchCommand, { name: "probabench", version: "0.0.0" });
