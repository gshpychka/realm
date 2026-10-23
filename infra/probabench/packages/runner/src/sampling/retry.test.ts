import * as AiError from "@effect/ai/AiError";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/TestClock";
import { MAX_RETRIES, type ProviderFailure, retryAfterMillis, withProviderRetry } from "./retry";

const origin = { module: "OpenRouterClient", method: "createChatCompletion" };
const request = {
  method: "POST" as const,
  url: "https://openrouter.ai/api/v1/chat/completions",
  urlParams: [] as ReadonlyArray<readonly [string, string]>,
  hash: Option.none(),
  headers: {},
};

const responseError = (
  status: number,
  headers: Record<string, string> = {},
  reason: AiError.HttpResponseError["reason"] = "StatusCode",
) => new AiError.HttpResponseError({ ...origin, reason, request, response: { status, headers } });

const requestError = (reason: AiError.HttpRequestError["reason"]) =>
  new AiError.HttpRequestError({ ...origin, reason, request });

const aborts = 1;
const retries = MAX_RETRIES + 1;

describe("withProviderRetry", () => {
  it.effect.each([
    [aborts, "400", responseError(400)],
    [aborts, "401", responseError(401)],
    [aborts, "403", responseError(403)],
    [aborts, "404", responseError(404)],
    [retries, "408", responseError(408)],
    [retries, "429", responseError(429)],
    [retries, "500", responseError(500)],
    [retries, "503", responseError(503)],
    [retries, "529", responseError(529)],
    [aborts, "a 200 with an undecodable body", responseError(200, {}, "Decode")],
    [retries, "a transport failure", requestError("Transport")],
    [retries, "a timeout", new Cause.TimeoutException()],
    [aborts, "an invalid URL", requestError("InvalidUrl")],
    [aborts, "a request encoding failure", requestError("Encode")],
    [aborts, "malformed output", new AiError.MalformedOutput(origin)],
  ] as const)("makes %i attempt(s) on %s", ([attempts, , failure]) =>
    Effect.gen(function* () {
      let made = 0;
      const fiber = yield* Effect.fork(
        withProviderRetry(
          Effect.failSync((): ProviderFailure => {
            made++;
            return failure;
          }),
        ),
      );
      yield* TestClock.adjust("10 minutes");
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      expect(made).toBe(attempts);
    }),
  );

  it.effect("waits for Retry-After before retrying a rate-limited request", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const call = Effect.suspend(() =>
        ++attempts === 1
          ? Effect.fail(responseError(429, { "retry-after": "30" }))
          : Effect.succeed("ok"),
      );
      const fiber = yield* Effect.fork(withProviderRetry(call));
      yield* TestClock.adjust("29 seconds");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("ok");
      expect(attempts).toBe(2);
    }),
  );
});

describe("retryAfterMillis", () => {
  it.each([
    ["2", 2000],
    ["Thu, 01 Jan 2026 00:00:30 GMT", 30_000],
    ["3600", 60_000],
    ["bad", 0],
    ["", 0],
  ] as const)("reads Retry-After %j as %i ms", (value, expected) => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(retryAfterMillis(responseError(429, { "retry-after": value }), now)).toBe(expected);
  });
});
