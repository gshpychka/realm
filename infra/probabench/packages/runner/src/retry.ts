// Retry policy for one provider request. Timeouts, transport failures, request
// timeouts (408), rate limits (429) and server errors (5xx) are transient: they
// are retried with jittered exponential backoff, waiting longer when the provider
// sends Retry-After. Any other failure, or a spent retry budget, aborts the run.
import type * as AiError from "@effect/ai/AiError";
import { MAX_RETRIES } from "@probabench/domain";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Why one provider request failed. */
export type ProviderFailure = AiError.AiError | Cause.TimeoutException;

/**
 * The longest Retry-After honoured per retry. A provider asking for an hour would
 * otherwise stall a paid run for hours without output.
 */
const MAX_RETRY_AFTER = Duration.minutes(1);

const isTransient = (failure: ProviderFailure): boolean => {
  switch (failure._tag) {
    case "TimeoutException":
      return true;
    case "HttpRequestError":
      return failure.reason === "Transport";
    case "HttpResponseError": {
      const { status } = failure.response;
      return failure.reason === "StatusCode" && (status === 408 || status === 429 || status >= 500);
    }
    default:
      return false;
  }
};

/**
 * Retry-After in milliseconds, capped at MAX_RETRY_AFTER. It can be seconds or an
 * HTTP date; an invalid or past value adds no delay.
 */
export const retryAfterMillis = (failure: ProviderFailure, now: number): number => {
  if (failure._tag !== "HttpResponseError") return 0;
  const header = Object.entries(failure.response.headers)
    .find(([name]) => name.toLowerCase() === "retry-after")?.[1]
    ?.trim();
  if (header === undefined || header === "") return 0;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - now;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.min(milliseconds, Duration.toMillis(MAX_RETRY_AFTER))
    : 0;
};

// The intersected schedule outputs [[failure, backoff], recurrences]; identity()
// passes the failure through so its Retry-After can stretch the backoff.
const retrySchedule = Schedule.identity<ProviderFailure>().pipe(
  Schedule.intersect(Schedule.exponential("200 millis", 2).pipe(Schedule.jittered)),
  Schedule.intersect(Schedule.recurs(MAX_RETRIES)),
  Schedule.modifyDelayEffect(([[failure]], delay) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        Duration.millis(Math.max(Duration.toMillis(delay), retryAfterMillis(failure, now))),
      ),
    ),
  ),
);

export const withProviderRetry = <A, R>(
  request: Effect.Effect<A, ProviderFailure, R>,
): Effect.Effect<A, ProviderFailure, R> =>
  Effect.retry(request, { schedule: retrySchedule, while: isTransient });
