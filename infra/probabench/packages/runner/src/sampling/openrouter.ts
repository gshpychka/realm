// OpenRouter's single-turn text endpoint. Decode the answer we measure; reasoning
// metadata is opaque and its provider-specific formats do not affect the sample.
import * as AiError from "@effect/ai/AiError";
import * as HttpBody from "@effect/platform/HttpBody";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ModelSeries } from "../plan/series";

export class MissingApiKey extends Data.TaggedError("MissingApiKey") {
  override get message() {
    return "OPENROUTER_API_KEY is not set. Run the CLI as probabench in the infra dev shell (nix develop .#infra), which loads the key from secrets/infra/probabench.env with sops exec-env.";
  }
}

export interface TextMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export class OpenRouterClient extends Context.Tag("probabench/OpenRouterClient")<
  OpenRouterClient,
  {
    readonly complete: (
      series: ModelSeries,
      maxTokens: number,
      messages: readonly TextMessage[],
    ) => Effect.Effect<string, AiError.AiError>;
  }
>() {}

// Some OpenAI routes require at least 16 tokens. Empty output (including an
// exhausted reasoning budget) is still an observation and is counted as invalid.
const NO_REASONING_MAX_TOKENS = 16;

const Completion = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.optionalWith(Schema.String, { nullable: true }) }),
    }),
  ),
});

/** Share authentication and preserve HTTP status, headers and error bodies for scheduling. */
export const openrouterClientLayer = Layer.effect(
  OpenRouterClient,
  Effect.gen(function* () {
    const key = yield* Config.redacted(Config.nonEmptyString("OPENROUTER_API_KEY")).pipe(
      Effect.mapError(() => new MissingApiKey()),
    );
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
      HttpClient.filterStatusOk,
    );
    const origin = { module: "OpenRouterClient", method: "complete" };
    return OpenRouterClient.of({
      complete: (series, maxTokens, messages) => {
        const request = HttpClientRequest.post("https://openrouter.ai/api/v1/chat/completions", {
          body: HttpBody.unsafeJson({
            model: series.modelSlug,
            messages,
            stream: false,
            max_tokens: series.reasoning === "off" ? NO_REASONING_MAX_TOKENS : maxTokens,
            reasoning:
              series.reasoning === "off"
                ? { enabled: false, exclude: true }
                : { effort: series.reasoning, exclude: true },
          }),
        }).pipe(HttpClientRequest.acceptJson);
        return client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Completion)),
          Effect.map((response) => response.choices[0].message.content ?? ""),
          Effect.catchTags({
            RequestError: (error) =>
              AiError.HttpRequestError.fromRequestError({ ...origin, error }),
            ResponseError: (error) =>
              AiError.HttpResponseError.fromResponseError({ ...origin, error }),
            ParseError: (error) => AiError.MalformedOutput.fromParseError({ ...origin, error }),
          }),
        );
      },
    });
  }),
);
