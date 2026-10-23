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

/** Convenient starting points; any OpenRouter model ID also works. */
export const MODEL_ALIASES: readonly [ModelAlias, ...ModelAlias[]] = [
  { alias: "claude-haiku-4.5", slug: "anthropic/claude-haiku-4.5" },
  { alias: "claude-sonnet-4.5", slug: "anthropic/claude-sonnet-4.5" },
  { alias: "claude-sonnet-4.5-high", slug: "anthropic/claude-sonnet-4.5", reasoning: "high" },
  { alias: "gpt-5-mini-low", slug: "openai/gpt-5-mini", reasoning: "low" },
  { alias: "gemini-2.5-flash", slug: "google/gemini-2.5-flash" },
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
