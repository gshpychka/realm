import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ResultsStore } from "./results-store";

/** Real temporary files exercise atomic rename, flush, cleanup, and schema decoding. */
export const withResultsStore = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R | ResultsStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "probabench-test-" });
    return yield* use(join(directory, "results.json")).pipe(Effect.provide(ResultsStore.Default));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

export const chatEndpoint = (text = "1") => {
  const requests: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
        const body = JSON.parse(new TextDecoder().decode(request.body.body)) as Record<
          string,
          unknown
        >;
        requests.push({ url: request.url, body });
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      }),
    ),
  );
  return { requests, layer };
};
