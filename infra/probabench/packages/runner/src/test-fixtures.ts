// Test fixtures shared by the runner's suites. Never import this from application code.
import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ResultsStore } from "./results-store";

/** A ResultsStore over a fresh temporary directory, so writes exercise the real filesystem. */
export const withResultsStore = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R | ResultsStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "probabench-test-" });
    return yield* use(join(directory, "results.json")).pipe(Effect.provide(ResultsStore.Default));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

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
}: {
  readonly unauthorized?: readonly string[];
} = {}) => {
  const requests: ChatRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
        const body = JSON.parse(new TextDecoder().decode(request.body.body)) as Record<
          string,
          unknown
        >;
        requests.push({ url: request.url, headers: request.headers, body });
        const response = unauthorized.includes(String(body.model))
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
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
              }),
              { headers: { "content-type": "application/json" } },
            );
        return HttpClientResponse.fromWeb(request, response);
      }),
    ),
  );
  return { requests, layer };
};
