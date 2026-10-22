import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { fetchResults } from "./results";

// Root-relative client URLs need an origin outside a browser.
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
beforeAll(() =>
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://localhost", pathname: "/" },
  }),
);
afterAll(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

const stubClientLayer = (body: string, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
    ),
  );

const emptyResults = JSON.stringify({ schemaVersion: 1, runs: [] });

describe("fetchResults", () => {
  it.effect("decodes an empty results document", () =>
    Effect.gen(function* () {
      const results = yield* fetchResults;
      expect(results.schemaVersion).toBe(2);
      expect(results.runs).toHaveLength(0);
    }).pipe(Effect.provide(stubClientLayer(emptyResults))),
  );

  it.effect("rejects a document that violates the Results schema", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(fetchResults);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(stubClientLayer(JSON.stringify({ schemaVersion: 1 })))),
  );

  it.effect("rejects a non-success HTTP status even when the body is valid results JSON", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(fetchResults);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left._tag).toBe("ResponseError");
    }).pipe(Effect.provide(stubClientLayer(emptyResults, 404))),
  );

  it.effect("rejects malformed JSON", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(fetchResults);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(stubClientLayer("<html>Service unavailable</html>"))),
  );
});
