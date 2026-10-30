import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { Atom } from "@effect-atom/atom-react";
import { HISTORY_ROUTES, HistoryPage, type Run } from "@probabench/domain";
import * as Effect from "effect/Effect";

/** The history, decoded against the Results contract. */
let history: { runs: readonly Run[] } = { runs: [] };
let cursor = 0;
const fetchResults = Effect.gen(function* () {
  const added: Run[] = [];
  let after = cursor;
  for (;;) {
    const page = yield* HttpClient.get(`${HISTORY_ROUTES.results}?after=${after}`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(HistoryPage)),
      Effect.timeout("15 seconds"),
      Effect.scoped,
    );
    added.push(...page.runs);
    if (page.cursor < after) return yield* Effect.fail(new Error("Invalid history cursor"));
    if (page.next === null) {
      cursor = page.cursor;
      if (added.length > 0) history = { runs: [...history.runs, ...added] };
      return history;
    }
    if (page.next <= after) return yield* Effect.fail(new Error("Invalid history cursor"));
    after = page.next;
  }
});

/** The page's results: Initial while loading, then Success or Failure. */
export const resultsAtom = Atom.make(fetchResults.pipe(Effect.provide(FetchHttpClient.layer)));
