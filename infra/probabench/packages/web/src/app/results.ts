import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { Atom } from "@effect-atom/atom-react";
import { RESULTS_FILE, Results } from "@probabench/domain";
import * as Effect from "effect/Effect";

/** The history, decoded against the Results contract. */
export const fetchResults = HttpClient.get(`/${RESULTS_FILE}`).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap(HttpClientResponse.schemaBodyJson(Results)),
  Effect.scoped,
);

/** The page's results: Initial while loading, then Success or Failure. */
export const resultsAtom = Atom.make(fetchResults.pipe(Effect.provide(FetchHttpClient.layer)));
