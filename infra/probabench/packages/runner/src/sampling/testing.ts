// Test fixtures for suites that talk to OpenRouter over HTTP. Never import this
// from application code.
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface ChatRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

/**
 * An HTTP client standing in for OpenRouter's chat completions endpoint. It records
 * every request and replies "1", or 401 to a model listed in `unauthorized`.
 */
export const chatEndpoint = ({
  unauthorized = [],
  reply,
}: {
  readonly unauthorized?: readonly string[];
  readonly reply?: (
    body: Readonly<Record<string, unknown>>,
    index: number,
  ) => Effect.Effect<Response | undefined>;
} = {}) => {
  const requests: ChatRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
        const body = JSON.parse(new TextDecoder().decode(request.body.body)) as Record<
          string,
          unknown
        >;
        requests.push({ url: request.url, headers: request.headers, body });
        const custom = yield* reply?.(body, requests.length) ?? Effect.succeed(undefined);
        const response =
          custom ??
          (unauthorized.includes(String(body.model))
            ? new Response(JSON.stringify({ error: { code: 401, message: "No auth" } }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            : new Response(
                JSON.stringify({
                  id: "chatcmpl-test",
                  object: "chat.completion",
                  created: 1,
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: "1" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0 },
                }),
                { headers: { "content-type": "application/json" } },
              ));
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  return { requests, layer };
};

/** Supplies a mock key without reading the real environment. */
export const withApiKey = (key: string) =>
  Effect.withConfigProvider(ConfigProvider.fromMap(new Map([["OPENROUTER_API_KEY", key]])));
