import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { afterAll, beforeAll, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { fetchResults } from "./results";

// Root-relative client URLs need an origin and a path outside a browser.
beforeAll(() => vi.stubGlobal("location", { origin: "http://localhost", pathname: "/" }));
afterAll(() => vi.unstubAllGlobals());

const stubClientLayer = (body: string, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
    ),
  );

const emptyResults = JSON.stringify({ runs: [] });

describe("fetchResults", () => {
  it.effect("decodes an empty results document", () =>
    Effect.gen(function* () {
      const results = yield* fetchResults;
      expect(results.runs).toEqual([]);
    }).pipe(Effect.provide(stubClientLayer(emptyResults))),
  );

  it.effect.each([
    ["a document the Results schema rejects", JSON.stringify({}), 200],
    ["a non-success status, even with a valid body", emptyResults, 404],
    ["a body that is not JSON", "<html>Service unavailable</html>", 200],
  ] as const)("fails on %s", ([, body, status]) =>
    Effect.exit(fetchResults).pipe(
      Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
      Effect.provide(stubClientLayer(body, status)),
    ),
  );
});
