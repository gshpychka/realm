// OpenRouter as the sampling LanguageModel: one client built from the API key,
// and per series a model layer that fixes its slug, reasoning and output ceiling.
import type * as LanguageModel from "@effect/ai/LanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import type * as HttpClient from "@effect/platform/HttpClient";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSeries } from "../plan/series";

export class MissingApiKey extends Data.TaggedError("MissingApiKey") {
  override get message() {
    return "OPENROUTER_API_KEY is not set. Run the CLI as probabench in the infra dev shell (nix develop .#infra), which loads the key from secrets/infra/probabench.env with sops exec-env.";
  }
}

/**
 * Output ceiling with reasoning off: room for one bit. Not lower, because OpenAI's
 * Responses API, which serves some OpenRouter routes, rejects a max_tokens below 16
 * and so would fail every sample. A model that cannot turn reasoning off may still
 * spend this budget thinking and reply with nothing, which records as invalid.
 */
const NO_REASONING_MAX_TOKENS = 16;

// The adapter's generated reasoning type only knows effort and summary. The
// client sends config as JSON without encoding it, so extending the type here
// still puts OpenRouter's documented `enabled` flag on the wire.
type Reasoning = NonNullable<OpenRouterLanguageModel.Config.Service["reasoning"]> & {
  readonly enabled?: boolean;
};

type ModelConfig = Omit<OpenRouterLanguageModel.Config.Service, "model" | "reasoning"> & {
  readonly reasoning: Reasoning;
};

/** The provider's default sampling, an explicit reasoning mode and a bounded output. */
const modelConfig = ({ reasoning }: ModelSeries, maxTokens: number): ModelConfig =>
  reasoning === "off"
    ? { max_tokens: NO_REASONING_MAX_TOKENS, reasoning: { enabled: false } }
    : { max_tokens: maxTokens, reasoning: { effort: reasoning } };

/** The client every series' model shares; building it reads the key from the environment. */
export const openrouterClientLayer: Layer.Layer<
  OpenRouterClient.OpenRouterClient,
  MissingApiKey,
  HttpClient.HttpClient
> = Layer.unwrapEffect(
  Config.redacted(Config.nonEmptyString("OPENROUTER_API_KEY")).pipe(
    Effect.mapError(() => new MissingApiKey()),
    Effect.map((apiKey) => OpenRouterClient.layer({ apiKey })),
  ),
);

export const openrouterModelLayer = (
  series: ModelSeries,
  maxTokens: number,
): Layer.Layer<LanguageModel.LanguageModel, never, OpenRouterClient.OpenRouterClient> =>
  OpenRouterLanguageModel.layer({ model: series.slug, config: modelConfig(series, maxTokens) });
