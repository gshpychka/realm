// Terminal setup and unattended flags feed the same daily sampling plan.
import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import * as Prompt from "@effect/cli/Prompt";
import { ReasoningMode, StepPercent, TrialsPerStep } from "@probabench/domain";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { estimateCost } from "../plan/cost";
import { planDaily } from "../plan/daily";
import { InvalidOptions, resolvePlan } from "../plan/plan";
import { loadPrices } from "../plan/pricing";
import { ALL_ALIASES, describeAliases, splitModels } from "../plan/series";
import { HISTORY_PATH, readSharedHistory, withSharedHistory } from "../store/results-store";
import { describeBriefing } from "./briefing";
import { DEFAULT_OPTIONS as DEFAULTS } from "./configuration";
import { executePlan } from "./execute";
import { configure } from "./setup";

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
      `Comma-separated OpenRouter model IDs (vendor/model) or saved names; defaults to "${ALL_ALIASES}".`,
    ),
  ),
  trials: integerFlag("trials", TrialsPerStep, "a positive integer").pipe(
    Options.optional,
    Options.withDescription(
      `Desired samples per probability today (default: ${DEFAULTS.trialsPerStep}).`,
    ),
  ),
  step: integerFlag("step", StepPercent, "from 1 to 100").pipe(
    Options.optional,
    Options.withDescription(
      `Target step from 1 to 100 percent (default: ${DEFAULTS.stepPercent}).`,
    ),
  ),
  maxTokens: integerFlag("max-tokens", PositiveInt, "a positive integer").pipe(
    Options.optional,
    Options.withDescription(
      `Output ceiling when reasoning is on (default: ${DEFAULTS.maxTokens}).`,
    ),
  ),
  concurrency: integerFlag("concurrency", PositiveInt, "a positive integer").pipe(
    Options.optional,
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
    Options.withDescription("Show the plan and cached API cost estimate without sampling."),
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
      models: splitModels(Option.getOrElse(flags.model, () => ALL_ALIASES)),
      reasoning: Option.getOrUndefined(flags.reasoning),
      options: {
        trialsPerStep: Option.getOrElse(flags.trials, () => DEFAULTS.trialsPerStep),
        stepPercent: Option.getOrElse(flags.step, () => DEFAULTS.stepPercent),
        concurrency: Option.getOrElse(flags.concurrency, () => DEFAULTS.concurrency),
        maxTokens: Option.getOrElse(flags.maxTokens, () => DEFAULTS.maxTokens),
      },
      out: HISTORY_PATH,
    });
    const terminal =
      process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== "dumb";
    if (terminal && !flags.yes && !flags.dryRun) {
      yield* Console.log("Loading history and prices…");
      const [history, prices] = yield* Effect.all([readSharedHistory(plan.out), loadPrices()], {
        concurrency: "unbounded",
      });
      const configured = yield* configure(plan, history, prices, {
        overrides: {
          models: Option.isSome(flags.model) ? plan.series : undefined,
          reasoning: Option.getOrUndefined(flags.reasoning),
          trials: Option.getOrUndefined(flags.trials),
          step: Option.getOrUndefined(flags.step),
          concurrency: Option.getOrUndefined(flags.concurrency),
          maxTokens: Option.getOrUndefined(flags.maxTokens),
        },
      });
      if (configured) yield* executePlan(configured);
      return;
    }
    const daily = planDaily(
      plan,
      yield* readSharedHistory(plan.out),
      new Date(yield* Clock.currentTimeMillis).toISOString(),
    );
    const estimate = yield* estimateCost(daily);
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
