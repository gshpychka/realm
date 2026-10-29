// The models a run can target and the reasoning it requests: tokens the CLI
// resolves and the dev bridge and setup form accept. The alias table lives here
// rather than in the runner so all three agree on it.
import * as Schema from "effect/Schema";

/** Reasoning a run requests from OpenRouter; "off" disables it. */
export const ReasoningMode = Schema.Literal("off", "low", "medium", "high", "xhigh");
export type ReasoningMode = typeof ReasoningMode.Type;

export interface Model {
  /** OpenRouter model ID. */
  readonly slug: string;
  /** Reasoning the model runs with unless a run overrides it; absent means off. */
  readonly reasoning?: Exclude<ReasoningMode, "off">;
}

interface ModelAlias extends Model {
  readonly alias: string;
}

/**
 * Saved models, checked against OpenRouter's catalog on 2026-10-29.
 * Versioned IDs keep comparisons attributable. Low reasoning leaves room for a
 * visible reply on models that require thinking; callers can override the effort.
 */
export const MODEL_ALIASES: readonly [ModelAlias, ...ModelAlias[]] = [
  { alias: "claude-haiku-5.5-low", slug: "anthropic/claude-haiku-5.5", reasoning: "low" },
  { alias: "claude-sonnet-5.5-low", slug: "anthropic/claude-sonnet-5.5", reasoning: "low" },
  { alias: "claude-opus-5.5-low", slug: "anthropic/claude-opus-5.5", reasoning: "low" },
  { alias: "claude-fable-5.1-low", slug: "anthropic/claude-fable-5.1", reasoning: "low" },
  { alias: "gpt-6-astra-low", slug: "openai/gpt-6-astra", reasoning: "low" },
  { alias: "gpt-6.1-sol-low", slug: "openai/gpt-6.1-sol", reasoning: "low" },
  { alias: "gpt-6.1-terra-low", slug: "openai/gpt-6.1-terra", reasoning: "low" },
  { alias: "gemini-4-argon-low", slug: "google/gemini-4-argon", reasoning: "low" },
  { alias: "grok-4.7-low", slug: "x-ai/grok-4.7", reasoning: "low" },
  { alias: "muse-wonder-low", slug: "meta/muse-wonder", reasoning: "low" },
  {
    alias: "deepseek-v4.1-flash-1017-low",
    slug: "deepseek/deepseek-v4.1-flash-1017",
    reasoning: "low",
  },
  { alias: "qwen3.8-max-0902-low", slug: "qwen/qwen3.8-max-0902", reasoning: "low" },
  { alias: "kimi-k3.1-pro-low", slug: "moonshotai/kimi-k3.1-pro", reasoning: "low" },
  { alias: "glm-5.3-low", slug: "z-ai/glm-5.3", reasoning: "low" },
  { alias: "minimax-m3.1-flash-low", slug: "minimax/minimax-m3.1-flash", reasoning: "low" },
];

/** An OpenRouter vendor/model ID, optionally with a :variant such as :free. */
export const ModelSlug = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/, {
    message: () => "Expected an OpenRouter vendor/model ID",
  }),
);
const isModelSlug = Schema.is(ModelSlug);

/**
 * The model one alias or OpenRouter model ID names, or undefined for any other token
 * (the CLI's "all" is not one model). Neither form can start with "-" or contain a
 * comma or whitespace, so a token that resolves is also safe to pass as one
 * command-line argument.
 */
export const resolveModel = (token: string): Model | undefined =>
  MODEL_ALIASES.find((model) => model.alias === token) ??
  (isModelSlug(token) ? { slug: token } : undefined);
