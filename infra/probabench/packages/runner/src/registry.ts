/** OpenRouter reasoning modes; sampling temperature/top-p always retain provider defaults. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ReasoningMode = "off" | ReasoningEffort;
export type ReasoningConfig =
  | { readonly effort: ReasoningEffort }
  | { readonly maxTokens: number }
  | { readonly enabled: true };

/** A resolved series; id is its canonical model/reasoning label, never a run identity. */
export interface BenchTarget {
  readonly id: string;
  readonly slug: string;
  readonly reasoning?: ReasoningConfig;
}

export interface ModelAlias {
  readonly alias: string;
  readonly slug: string;
  readonly reasoning?: ReasoningConfig;
}

/** Convenient starting points; arbitrary OpenRouter vendor/model slugs also work. */
export const MODEL_ALIASES = [
  { alias: "claude-haiku-4.5", slug: "anthropic/claude-haiku-4.5" },
  { alias: "claude-sonnet-4.5", slug: "anthropic/claude-sonnet-4.5" },
  {
    alias: "claude-sonnet-4.5-high",
    slug: "anthropic/claude-sonnet-4.5",
    reasoning: { effort: "high" },
  },
  { alias: "gpt-5-mini-low", slug: "openai/gpt-5-mini", reasoning: { effort: "low" } },
  { alias: "gemini-2.5-flash", slug: "google/gemini-2.5-flash" },
] as const satisfies readonly ModelAlias[];

export const reasoningLabel = (reasoning: ReasoningConfig | undefined): string => {
  if (reasoning === undefined) return "off";
  if ("effort" in reasoning) return reasoning.effort;
  if ("maxTokens" in reasoning) return `budget:${reasoning.maxTokens}`;
  return "enabled";
};

export const modelLabel = (slug: string, reasoning: ReasoningConfig | undefined): string =>
  reasoning === undefined ? slug : `${slug} [reasoning=${reasoningLabel(reasoning)}]`;

const target = (
  model: { readonly slug: string; readonly reasoning?: ReasoningConfig },
  mode?: ReasoningMode,
): BenchTarget => {
  const reasoning =
    mode === undefined ? model.reasoning : mode === "off" ? undefined : { effort: mode };
  return {
    id: modelLabel(model.slug, reasoning),
    slug: model.slug,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
};

export const TARGETS: readonly BenchTarget[] = MODEL_ALIASES.map((alias) => target(alias));
export const allTargetIds: readonly string[] = MODEL_ALIASES.map((alias) => alias.alias);
export const ALL_TARGETS = "all";

export const isModelSlug = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);

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
    ...MODEL_ALIASES.map(
      (model) =>
        `  ${model.alias} → ${modelLabel(model.slug, "reasoning" in model ? model.reasoning : undefined)}`,
    ),
    "  all → every alias",
    "Use --reasoning off|low|medium|high|xhigh to override the selected models' reasoning mode.",
  ].join("\n");
