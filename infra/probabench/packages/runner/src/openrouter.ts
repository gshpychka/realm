// OpenRouter provider layers, served over its OpenAI Chat-Completions-compatible surface.
// The shared client layer reads the API key once via Config.redacted (the base URL is
// built into @effect/ai-openrouter); the per-target layer factory bakes the target's
// reasoning config onto the model config so BitSampler/Benchmark stay model-agnostic —
// the caller provides a target-specific layer around each sub-sweep.

import type * as LanguageModel from "@effect/ai/LanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Config from "effect/Config";
import type * as ConfigError from "effect/ConfigError";
import type * as Layer from "effect/Layer";
import type { BenchTarget } from "./registry";

/** Token ceiling for a no-reasoning target: room for a single bit and nothing more. */
const NO_REASONING_MAX_TOKENS = 8;

// The adapter's generated reasoning type only knows effort and summary. The
// client sends config as JSON without encoding it, so extending the type here
// still puts OpenRouter's documented `enabled` flag on the wire.
type Reasoning = NonNullable<OpenRouterLanguageModel.Config.Service["reasoning"]> & {
  readonly enabled?: boolean;
};

type ModelConfig = Omit<OpenRouterLanguageModel.Config.Service, "model" | "reasoning"> & {
  readonly reasoning: Reasoning;
};

/** Native sampling defaults, explicit reasoning mode, and a bounded output budget. */
export const toOpenRouterConfig = ({ reasoning }: BenchTarget, maxTokens: number): ModelConfig =>
  reasoning === "off"
    ? { max_tokens: NO_REASONING_MAX_TOKENS, reasoning: { enabled: false } }
    : { max_tokens: maxTokens, reasoning: { effort: reasoning } };

/** The shared OpenRouter client, built once from `OPENROUTER_API_KEY` (redacted). */
export const openrouterApiKey = Config.redacted(
  Config.nonEmptyString("OPENROUTER_API_KEY").pipe(
    Config.validate({
      message: "OPENROUTER_API_KEY must not be blank.",
      validation: (key) => key.trim().length > 0,
    }),
  ),
);

export const openrouterClientLayer: Layer.Layer<
  OpenRouterClient.OpenRouterClient,
  ConfigError.ConfigError,
  HttpClient.HttpClient
> = OpenRouterClient.layerConfig({ apiKey: openrouterApiKey });

/**
 * The LanguageModel layer for one target's sub-sweep, with the target's reasoning config
 * baked into the model config. Requires the shared {@link openrouterClientLayer}.
 */
export const openrouterModelLayer = (
  target: BenchTarget,
  maxTokens: number,
): Layer.Layer<LanguageModel.LanguageModel, never, OpenRouterClient.OpenRouterClient> =>
  OpenRouterLanguageModel.layer({
    model: target.slug,
    config: toOpenRouterConfig(target, maxTokens),
  });
