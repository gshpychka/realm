// Resolves the CLI's model tokens (aliases, OpenRouter model IDs and "all") into
// benchmark targets, one per model series.
import { MODEL_ALIASES, type Model, ReasoningMode, resolveModel } from "@probabench/domain";

/** CLI token expanding to every alias; a browser run takes exactly one model. */
export const ALL_ALIASES = "all";

/** A resolved series; id is the series label persisted as Run.model, never a run identity. */
export interface BenchTarget {
  readonly id: string;
  /** OpenRouter model ID, e.g. "anthropic/claude-haiku-4.5". */
  readonly slug: string;
  readonly reasoning: ReasoningMode;
}

export const modelLabel = (slug: string, reasoning: ReasoningMode): string =>
  reasoning === "off" ? slug : `${slug} [reasoning=${reasoning}]`;

const target = (model: Model, mode?: ReasoningMode): BenchTarget => {
  const reasoning = mode ?? model.reasoning ?? "off";
  return { id: modelLabel(model.slug, reasoning), slug: model.slug, reasoning };
};

const modelsFor = (token: string): readonly Model[] => {
  if (token === ALL_ALIASES) return MODEL_ALIASES;
  const model = resolveModel(token);
  return model ? [model] : [];
};

/** The tokens of a comma-separated model list, trimmed. */
export const splitModels = (list: string): readonly string[] =>
  list
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

interface TargetSelection {
  readonly targets: readonly BenchTarget[];
  readonly unknown: readonly string[];
}

/**
 * Resolves tokens from splitModels in request order, deduping aliases and model IDs
 * that name the same series. `mode` overrides every target's reasoning.
 */
export const selectTargets = (tokens: readonly string[], mode?: ReasoningMode): TargetSelection => {
  const targets = new Map<string, BenchTarget>();
  const unknown: string[] = [];
  for (const token of tokens) {
    const models = modelsFor(token);
    if (models.length === 0) unknown.push(token);
    for (const model of models) {
      const resolved = target(model, mode);
      targets.set(resolved.id, resolved);
    }
  }
  return { targets: [...targets.values()], unknown };
};

export const describeAliases = (): string =>
  [
    "OpenRouter model aliases (or pass any OpenRouter model ID):",
    ...MODEL_ALIASES.map((model) => `  ${model.alias} → ${target(model).id}`),
    `  ${ALL_ALIASES} → every alias`,
    `Use --reasoning ${ReasoningMode.literals.join("|")} to override the selected models' reasoning mode.`,
  ].join("\n");
