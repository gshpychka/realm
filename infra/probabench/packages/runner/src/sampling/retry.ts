// Retry policy for one provider request. Timeouts, transport failures, request
// timeouts (408), rate limits (429) and server errors (5xx) are transient: they
// are retried with jittered exponential backoff, waiting longer when the provider
// sends Retry-After. A permanent failure or spent retry budget stops that model.
import type * as AiError from "@effect/ai/AiError";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** Retries after a sample's first provider attempt. */
export const MAX_RETRIES = 5;

/** Why one provider request failed. */
export type ProviderFailure = AiError.AiError | Cause.TimeoutException;

/**
 * The first backoff, doubling with each retry: about 30 s across all of them, so a
 * burst of 429s without Retry-After can outlast a short rate-limit window.
 */
const FIRST_BACKOFF = "1 second";

const ErrorBody = Schema.parseJson(
  Schema.Struct({
    error: Schema.Struct({
      metadata: Schema.optional(
        Schema.Struct({
          limit_source: Schema.optional(Schema.String),
          reason: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
);

/** A temporary spending hold is the only retryable 402; exhausted credits are permanent. */
export const inFlightBudgetLimited = (failure: ProviderFailure): boolean => {
  if (failure._tag !== "HttpResponseError" || failure.response.status !== 402) return false;
  const body = Schema.decodeUnknownOption(ErrorBody)(failure.body);
  if (Option.isNone(body)) return false;
  const metadata = body.value.error.metadata;
  return (
    metadata?.limit_source === "openrouter_in_flight_budget" &&
    metadata.reason === "in_flight_budget_exhausted" &&
    Boolean(failure.response.headers["retry-after"]?.trim())
  );
};

const isTransient = (failure: ProviderFailure): boolean => {
  switch (failure._tag) {
    case "TimeoutException":
      return true;
    case "HttpRequestError":
      return failure.reason === "Transport";
    case "HttpResponseError": {
      const { status } = failure.response;
      return status === 408 || status === 429 || status >= 500 || inFlightBudgetLimited(failure);
    }
    default:
      return false;
  }
};

/**
 * Retry-After in milliseconds. It can be seconds or an
 * HTTP date; an invalid or past value adds no delay.
 */
export const retryAfterMillis = (failure: ProviderFailure, now: number): number => {
  if (failure._tag !== "HttpResponseError") return 0;
  // @effect/platform lowercases header names.
  const header = failure.response.headers["retry-after"]?.trim();
  if (header === undefined || header === "") return 0;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - now;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
};

/** Gateway quota resets can be supplied without Retry-After, including daily free quotas. */
export const providerDelayMillis = (failure: ProviderFailure, now: number): number => {
  const retryAfter = retryAfterMillis(failure, now);
  if (
    failure._tag !== "HttpResponseError" ||
    failure.response.status !== 429 ||
    failure.response.headers["x-ratelimit-remaining"]?.trim() !== "0"
  )
    return retryAfter;
  const reset = failure.response.headers["x-ratelimit-reset"]?.trim();
  if (!reset) return retryAfter;
  // Accept absolute Unix timestamps in seconds or milliseconds, and HTTP dates.
  const number = Number(reset);
  const timestamp = Number.isFinite(number)
    ? number * (number < 1e12 ? 1000 : 1)
    : Date.parse(reset);
  return Number.isFinite(timestamp) ? Math.max(retryAfter, timestamp - now, 0) : retryAfter;
};

// The intersected schedule outputs [[failure, backoff], recurrences]; identity()
// passes the failure through so its Retry-After can stretch the backoff.
const retrySchedule = Schedule.identity<ProviderFailure>().pipe(
  Schedule.intersect(Schedule.exponential(FIRST_BACKOFF, 2).pipe(Schedule.jittered)),
  Schedule.intersect(Schedule.recurs(MAX_RETRIES)),
  Schedule.modifyDelayEffect(([[failure]], delay) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        Duration.millis(Math.max(Duration.toMillis(delay), providerDelayMillis(failure, now))),
      ),
    ),
  ),
);

export const withProviderRetry = <A, R>(
  request: Effect.Effect<A, ProviderFailure, R>,
): Effect.Effect<A, ProviderFailure, R> =>
  Effect.retry(request, { schedule: retrySchedule, while: isTransient });
