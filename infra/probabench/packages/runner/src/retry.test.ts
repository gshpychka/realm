import * as AiError from "@effect/ai/AiError";
import { describe, expect, it } from "@effect/vitest";
import { MAX_RETRIES } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/TestClock";
import { LlmError } from "./bit-sampler";
import {
  isRetryableAiError,
  isRetryableLlmError,
  isRetryableStatus,
  withProviderRetry,
} from "./retry";

const request = {
  method: "POST" as const,
  url: "https://api.anthropic.com/v1/messages",
  urlParams: [] as ReadonlyArray<readonly [string, string]>,
  hash: Option.none(),
  headers: {},
};

const responseError = (status: number) =>
  new AiError.HttpResponseError({
    module: "Anthropic",
    method: "createMessage",
    reason: "StatusCode",
    request,
    response: { status, headers: {} },
  });

const requestError = new AiError.HttpRequestError({
  module: "Anthropic",
  method: "createMessage",
  reason: "Transport",
  request,
});

describe("isRetryableStatus", () => {
  for (const status of [429, 500, 502, 503, 529]) {
    it(`treats ${status} as retryable`, () => {
      expect(isRetryableStatus(status)).toBe(true);
    });
  }
  for (const status of [400, 401, 403, 404, 422]) {
    it(`treats ${status} as non-retryable`, () => {
      expect(isRetryableStatus(status)).toBe(false);
    });
  }
});

describe("isRetryableAiError", () => {
  it("retries on a 429/5xx/529 HTTP response", () => {
    expect(isRetryableAiError(responseError(429))).toBe(true);
    expect(isRetryableAiError(responseError(503))).toBe(true);
    expect(isRetryableAiError(responseError(529))).toBe(true);
  });
  it("aborts on 401/403/404 HTTP responses", () => {
    expect(isRetryableAiError(responseError(401))).toBe(false);
    expect(isRetryableAiError(responseError(403))).toBe(false);
    expect(isRetryableAiError(responseError(404))).toBe(false);
  });
  it("retries on a transport-level request error", () => {
    expect(isRetryableAiError(requestError)).toBe(true);
  });
  it("aborts on a malformed-output error (not transient)", () => {
    expect(
      isRetryableAiError(
        new AiError.MalformedOutput({ module: "Anthropic", method: "createMessage" }),
      ),
    ).toBe(false);
  });
});

describe("isRetryableLlmError", () => {
  it("classifies by the wrapped AiError", () => {
    expect(isRetryableLlmError(new LlmError({ cause: responseError(529) }))).toBe(true);
    expect(isRetryableLlmError(new LlmError({ cause: responseError(404) }))).toBe(false);
  });
});

describe("withProviderRetry", () => {
  it.effect("aborts immediately on a non-retryable error (one attempt, no backoff)", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const failing = Effect.failSync(() => {
        attempts++;
        return new LlmError({ cause: responseError(401) });
      });
      const exit = yield* Effect.exit(withProviderRetry(failing));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toBe(1);
    }),
  );

  it.effect("retries a retryable error until the schedule is exhausted, then aborts", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const failing = Effect.failSync(() => {
        attempts++;
        return new LlmError({ cause: responseError(529) });
      });
      const fiber = yield* Effect.fork(withProviderRetry(failing));
      yield* TestClock.adjust("10 minutes");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toBe(MAX_RETRIES + 1);
    }),
  );
});

import { retryAfterMillis } from "./retry";

describe("transport retry details", () => {
  it("retries HTTP request timeout but not invalid URLs or request encoding failures", () => {
    expect(isRetryableStatus(408)).toBe(true);
    for (const reason of ["InvalidUrl", "Encode"] as const) {
      expect(
        isRetryableAiError(
          new AiError.HttpRequestError({ module: "test", method: "test", reason, request }),
        ),
      ).toBe(false);
    }
  });

  it.effect("respects Retry-After before retrying a rate-limited request", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const limited = new LlmError({
        cause: new AiError.HttpResponseError({
          ...responseError(429),
          response: { status: 429, headers: { "retry-after": "30" } },
        }),
      });
      const call = Effect.suspend(() =>
        ++attempts === 1 ? Effect.fail(limited) : Effect.succeed("ok"),
      );
      const fiber = yield* Effect.fork(withProviderRetry(call));
      yield* TestClock.adjust("29 seconds");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toBe("ok");
      expect(attempts).toBe(2);
    }),
  );

  it("supports HTTP dates, case-insensitive headers, and invalid Retry-After values", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    for (const [value, expected] of [
      ["2", 2000],
      ["Thu, 01 Jan 2026 00:00:30 GMT", 30000],
      ["bad", 0],
      ["", 0],
    ] as const) {
      const error = new LlmError({
        cause: new AiError.HttpResponseError({
          ...responseError(429),
          response: { status: 429, headers: { "Retry-After": value } },
        }),
      });
      expect(retryAfterMillis(error, now)).toBe(expected);
    }
  });
});
