// Transport retry/abort policy for provider sampling calls. Rate limiting (429),
// Anthropic overload (529), and 5xx are transient and retried with jittered
// exponential backoff; auth/not-found (401/403/404) and other non-transport
// failures abort the run, as does exhausting the retry budget.
import type * as AiError from "@effect/ai/AiError";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { LlmError } from "./bit-sampler";

/** How many retries follow the first attempt before a retryable failure aborts the run. */
export const MAX_RETRIES = 5;

/** HTTP statuses worth retrying: rate limiting (429), overload (529), and any 5xx. */
export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status < 600);

/**
 * Classifies a provider failure. Transport-level request errors and retryable HTTP
 * statuses are transient; decode/auth/not-found failures abort the run.
 */
export const isRetryableAiError = (error: AiError.AiError): boolean => {
  switch (error._tag) {
    case "HttpResponseError":
      return error.reason === "StatusCode" && isRetryableStatus(error.response.status);
    case "HttpRequestError":
      return error.reason === "Transport";
    default:
      return false;
  }
};

/** Whether the sampling failure's underlying transport error is worth retrying. */
export const isRetryableLlmError = (error: LlmError): boolean =>
  error.cause._tag === "TimeoutException" || isRetryableAiError(error.cause);

/** Retry-After can be seconds or an HTTP date. Invalid and past values add no delay. */
export const retryAfterMillis = (error: LlmError, now: number): number => {
  if (error.cause._tag !== "HttpResponseError") return 0;
  const header = Object.entries(error.cause.response.headers)
    .find(([name]) => name.toLowerCase() === "retry-after")?.[1]
    ?.trim();
  if (header === undefined || header === "") return 0;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(header)
    ? Number(header) * 1000
    : Date.parse(header) - now;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
};

/** Jittered exponential backoff bounded to {@link MAX_RETRIES} retries. */
export const retrySchedule = Schedule.identity<LlmError>().pipe(
  Schedule.intersect(Schedule.exponential("200 millis", 2).pipe(Schedule.jittered)),
  Schedule.intersect(Schedule.recurs(MAX_RETRIES)),
  Schedule.modifyDelayEffect(([[error]], delay) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        Duration.millis(Math.max(Duration.toMillis(delay), retryAfterMillis(error, now))),
      ),
    ),
  ),
);

/**
 * Wraps a sampling effect with the transport retry/abort policy: retries only while the
 * failure is retryable and the backoff schedule has budget left; otherwise the failure
 * propagates (abort on a non-retryable error or on retry exhaustion).
 */
export const withProviderRetry = <A, R>(
  effect: Effect.Effect<A, LlmError, R>,
): Effect.Effect<A, LlmError, R> =>
  Effect.retry(effect, { schedule: retrySchedule, while: isRetryableLlmError });
