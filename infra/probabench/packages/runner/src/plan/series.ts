// Resolves the CLI's model tokens (aliases, OpenRouter model IDs and "all") into
// the model series a benchmark samples.
import {
  MODEL_ALIASES,
  type Model,
  ReasoningMode,
  type Run,
  resolveModel,
  seriesLabel,
} from "@probabench/domain";

/** CLI token expanding to every alias; a browser run takes exactly one model. */
export const ALL_ALIASES = "all";

/** A model series to benchmark: the fields every Run of it records. */
export type ModelSeries = Pick<Run, "model" | "modelSlug" | "reasoning">;

const toSeries = (model: Model, mode?: ReasoningMode): ModelSeries => {
  const reasoning = mode ?? model.reasoning ?? "off";
  return { model: seriesLabel(model.slug, reasoning), modelSlug: model.slug, reasoning };
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

interface SeriesSelection {
  readonly series: readonly ModelSeries[];
  readonly unknown: readonly string[];
}

/**
 * Resolves tokens from splitModels in request order, deduping aliases and model IDs
 * that name the same series. `mode` overrides every series' reasoning.
 */
export const selectSeries = (tokens: readonly string[], mode?: ReasoningMode): SeriesSelection => {
  const series = new Map<string, ModelSeries>();
  const unknown: string[] = [];
  for (const token of tokens) {
    const models = modelsFor(token);
    if (models.length === 0) unknown.push(token);
    for (const model of models) {
      const resolved = toSeries(model, mode);
      series.set(resolved.model, resolved);
    }
  }
  return { series: [...series.values()], unknown };
};

export const describeAliases = (): string =>
  [
    "OpenRouter model aliases (or pass any OpenRouter model ID):",
    ...MODEL_ALIASES.map((model) => `  ${model.alias} → ${toSeries(model).model}`),
    `  ${ALL_ALIASES} → every alias`,
    `Use --reasoning ${ReasoningMode.literals.join("|")} to override the selected models' reasoning mode.`,
  ].join("\n");
