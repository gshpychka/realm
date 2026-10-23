// Model tokens the CLI resolves and the dev bridge and setup form accept. The
// alias table lives here rather than in the runner so all three agree on it.
import type { ReasoningEffort } from "./schema";

export interface ModelAlias {
  readonly alias: string;
  readonly slug: string;
  /** Reasoning the alias requests unless a run overrides it; absent means off. */
  readonly reasoning?: ReasoningEffort;
}

/** Convenient starting points; any OpenRouter vendor/model slug also works. */
export const MODEL_ALIASES: readonly [ModelAlias, ...ModelAlias[]] = [
  { alias: "claude-haiku-4.5", slug: "anthropic/claude-haiku-4.5" },
  { alias: "claude-sonnet-4.5", slug: "anthropic/claude-sonnet-4.5" },
  { alias: "claude-sonnet-4.5-high", slug: "anthropic/claude-sonnet-4.5", reasoning: "high" },
  { alias: "gpt-5-mini-low", slug: "openai/gpt-5-mini", reasoning: "low" },
  { alias: "gemini-2.5-flash", slug: "google/gemini-2.5-flash" },
];

/** CLI token expanding to every alias; a browser run takes exactly one model. */
export const ALL_TARGETS = "all";

/** An OpenRouter vendor/model ID, optionally with a :variant such as :free. */
export const isModelSlug = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);

/**
 * One alias or vendor/model slug: exactly the single tokens the runner resolves.
 * Neither form can start with "-" or contain a comma or whitespace, so a token is
 * also safe to pass as one command-line argument.
 */
export const isModelToken = (token: string): boolean =>
  MODEL_ALIASES.some((model) => model.alias === token) || isModelSlug(token);
