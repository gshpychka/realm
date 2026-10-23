// Guided setup: what an interactive terminal is asked when no --model is given.
// It runs offline, offering the aliases or any OpenRouter model ID.
import * as Prompt from "@effect/cli/Prompt";
import {
  MODEL_ALIASES,
  planBudget,
  REASONING_LABELS,
  ReasoningMode,
  SAMPLING_PRESETS,
  seriesLabel,
} from "@probabench/domain";
import * as Effect from "effect/Effect";
import type { SamplingOptions } from "../plan/plan";
import { ALL_ALIASES, selectTargets, splitModels } from "../plan/targets";

type Sizing = Pick<SamplingOptions, "trialsPerStep" | "stepPercent">;

const modelChoices: ReadonlyArray<Prompt.Prompt.SelectChoice<readonly string[] | "custom">> = [
  ...MODEL_ALIASES.map((model) => ({
    title: `${model.alias} · ${seriesLabel(model.slug, model.reasoning ?? "off")}`,
    value: [model.alias],
  })),
  { title: "Enter another OpenRouter model", value: "custom" },
  { title: "Run every alias", value: [ALL_ALIASES] },
];

const sizeChoices: ReadonlyArray<Prompt.Prompt.SelectChoice<Sizing | "custom">> = [
  ...SAMPLING_PRESETS.map((preset) => {
    const { points, samples } = planBudget(preset);
    return {
      title: `${preset.label} — ${preset.trialsPerStep} trials × ${points} points (${preset.stepPercent}% step): ${samples.toLocaleString("en")} samples per model`,
      value: preset,
    };
  }),
  { title: "Custom trial count and probability step", value: "custom" },
];

const promptCustomModels = Prompt.text({
  message: "OpenRouter model ID, vendor/model (comma-separated for several)",
  validate: (list) => {
    const { targets, unknown } = selectTargets(splitModels(list));
    return targets.length > 0 && unknown.length === 0
      ? Effect.succeed(list)
      : Effect.fail("Enter a listed alias or an OpenRouter model ID (vendor/model).");
  },
}).pipe(Effect.map(splitModels));

const promptCustomSizing = Effect.all({
  trialsPerStep: Prompt.integer({
    message: "Samples at each probability",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  }),
  stepPercent: Prompt.integer({ message: "Probability step (percent)", min: 1, max: 100 }),
});

const promptReasoning = Prompt.select({
  message: "Reasoning mode",
  choices: ReasoningMode.literals.map((value) => ({ title: REASONING_LABELS[value], value })),
});

/**
 * Asks only what the flags left open: --trials or --step skips the size question, and
 * --reasoning skips the reasoning one. Aliases carry their own reasoning mode, so only
 * a hand-entered model is asked for one.
 */
export const promptRunSetup = (ask: { readonly size: boolean; readonly reasoning: boolean }) =>
  Effect.gen(function* () {
    const selected = yield* Prompt.select({ message: "Choose a model", choices: modelChoices });
    const custom = selected === "custom";
    const models = custom ? yield* promptCustomModels : selected;
    const preset = ask.size
      ? yield* Prompt.select({ message: "Benchmark size", choices: sizeChoices })
      : undefined;
    const sizing = preset === "custom" ? yield* promptCustomSizing : preset;
    const reasoning = custom && ask.reasoning ? yield* promptReasoning : undefined;
    return { models, sizing, reasoning };
  });
