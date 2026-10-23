import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { Results } from "@probabench/domain";
import * as Effect from "effect/Effect";

// The runner's DEFAULT_OUT lives in public/data, which Vite serves at this URL.
export const RESULTS_URL = "/data/results.json";

/** Fetch /data/results.json and Schema-decode it against the shared Results contract. Requires an HttpClient. */
export const fetchResults = HttpClient.get(RESULTS_URL).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(Results)),
  Effect.scoped,
);

/** The results loader backed by the browser fetch implementation. */
export const loadResults = fetchResults.pipe(Effect.provide(FetchHttpClient.layer));
