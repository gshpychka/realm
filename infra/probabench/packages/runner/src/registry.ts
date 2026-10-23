import {
  ALL_TARGETS,
  isModelSlug,
  MODEL_ALIASES,
  type ModelAlias,
  ReasoningMode,
} from "@probabench/domain";

/** A resolved series; id is the series label persisted as Run.model, never a run identity. */
export interface BenchTarget {
  readonly id: string;
  readonly slug: string;
  readonly reasoning: ReasoningMode;
}

export const modelLabel = (slug: string, reasoning: ReasoningMode): string =>
  reasoning === "off" ? slug : `${slug} [reasoning=${reasoning}]`;

const target = (model: Omit<ModelAlias, "alias">, mode?: ReasoningMode): BenchTarget => {
  const reasoning = mode ?? model.reasoning ?? "off";
  return { id: modelLabel(model.slug, reasoning), slug: model.slug, reasoning };
};

export interface TargetSelection {
  readonly targets: readonly BenchTarget[];
  readonly unknown: readonly string[];
}

/** Preserve requested order, deduping aliases/slugs that resolve to the same experiment. */
export const selectTargets = (tokens: readonly string[], mode?: ReasoningMode): TargetSelection => {
  const targets = new Map<string, BenchTarget>();
  const unknown: string[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    const alias = MODEL_ALIASES.find((candidate) => candidate.alias === token);
    const models =
      token === ALL_TARGETS
        ? MODEL_ALIASES
        : alias === undefined
          ? isModelSlug(token)
            ? [{ slug: token }]
            : []
          : [alias];
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
    "OpenRouter model aliases (or pass any vendor/model slug):",
    ...MODEL_ALIASES.map((model) => `  ${model.alias} → ${target(model).id}`),
    `  ${ALL_TARGETS} → every alias`,
    `Use --reasoning ${ReasoningMode.literals.join("|")} to override the selected models' reasoning mode.`,
  ].join("\n");
