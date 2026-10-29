// The dev bridge's HTTP contract, shared by the Vite plugin (dev-bridge/) and the
// browser client. Every route answers with BridgeStatus, or BridgeFailure on error.
import { DEFAULT_CONCURRENCY, planBudget, ReasoningMode, resolveModel } from "@probabench/domain";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

export const BRIDGE_ROUTES = {
  status: "/api/bench/status",
  estimate: "/api/bench/estimate",
  run: "/api/bench/run",
  cancel: "/api/bench/cancel",
} as const;

/** What the page lets one run ask for; the CLI accepts larger runs. */
export const BROWSER_LIMITS = {
  trialsPerStep: 10_000,
  concurrency: DEFAULT_CONCURRENCY,
  samples: 100_000,
} as const;

const wholeNumber = (label: string, max: number) =>
  Schema.Number.pipe(
    Schema.filter((value) => Number.isSafeInteger(value) && value >= 1 && value <= max, {
      message: () => `${label} must be a whole number from 1 to ${max.toLocaleString("en")}.`,
    }),
  );

/** A run the page may start: settings the form can express, within the browser's sample budget. */
export const BenchRequest = Schema.Struct({
  model: Schema.String.pipe(
    Schema.filter((token) => resolveModel(token) !== undefined, {
      message: () => "Choose one model from the saved list or use an OpenRouter vendor/model ID.",
    }),
  ),
  trialsPerStep: wholeNumber("Samples per target", BROWSER_LIMITS.trialsPerStep),
  stepPercent: wholeNumber("Target step", 100),
  concurrency: wholeNumber("Concurrent requests", BROWSER_LIMITS.concurrency),
  reasoning: Schema.optional(ReasoningMode),
}).pipe(
  Schema.filter((request) => planBudget(request).samples <= BROWSER_LIMITS.samples, {
    message: () =>
      `Browser benchmarks support up to ${BROWSER_LIMITS.samples.toLocaleString("en")} samples. ` +
      "Run larger benchmarks with the probabench CLI.",
  }),
);
export type BenchRequest = typeof BenchRequest.Type;

/** One run started from the page, with the tail of the runner's output. */
export const Job = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("running", "completed", "failed", "cancelled"),
  startedAt: Schema.String,
  log: Schema.String,
  /** Newly saved sample counts; null before the first progress report. */
  progress: Schema.NullOr(Schema.Struct({ completed: Schema.Int, total: Schema.Int })),
  error: Schema.optional(Schema.String),
});
export type Job = typeof Job.Type;

export const BridgeStatus = Schema.Struct({
  /** Whether the dev server has the OpenRouter key. */
  configured: Schema.Boolean,
  /** The latest run since the dev server started. */
  job: Schema.NullOr(Job),
});
export type BridgeStatus = typeof BridgeStatus.Type;

export const BridgeFailure = Schema.Struct({ error: Schema.String });
export type BridgeFailure = typeof BridgeFailure.Type;

/**
 * The first problem in a decode as one sentence. Field rules carry their own messages;
 * Effect's generic ones (a missing or mistyped field) get the field name in front.
 */
export const firstIssue = (error: ParseResult.ParseError): string => {
  const [issue] = ParseResult.ArrayFormatter.formatErrorSync(error);
  if (issue === undefined) return "Invalid benchmark settings.";
  return issue._tag === "Refinement" || issue.path.length === 0
    ? issue.message
    : `${issue.path.join(".")}: ${issue.message}`;
};
