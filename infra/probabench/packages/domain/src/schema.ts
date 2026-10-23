// The persisted results contract.
import * as Schema from "effect/Schema";

export const SCHEMA_VERSION = 2;

/** A target probability as a fraction in [0, 1]. */
export const Probability = Schema.Number.pipe(Schema.between(0, 1), Schema.brand("Probability"));
export type Probability = typeof Probability.Type;

/** One trial's outcome: a bit, or the raw text of an unparseable reply. */
export const Outcome = Schema.Union(
  Schema.Literal(0, 1),
  Schema.Struct({ invalidText: Schema.String }),
);
export type Outcome = typeof Outcome.Type;

/** Every outcome sampled at one target probability. */
export const Point = Schema.Struct({
  x: Probability,
  outcomes: Schema.Array(Outcome),
});
export type Point = typeof Point.Type;

/**
 * Canonical Date.toISOString() form, so string order is chronological: the web
 * history sorts runs with localeCompare.
 */
const IsoTimestamp = Schema.String.pipe(
  Schema.filter(
    (value) => {
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
    },
    { message: () => "Expected an ISO UTC timestamp as emitted by Date.toISOString()" },
  ),
);

/** One immutable sweep of one model series. */
export const Run = Schema.Struct({
  /** Identifies this execution; a series keeps every earlier run. */
  id: Schema.NonEmptyTrimmedString,
  /**
   * Series key that groups runs: modelSlug, plus ` [reasoning=<mode>]` unless reasoning
   * is off. Written by the runner's modelLabel; display-only, never sent to the API.
   */
  model: Schema.NonEmptyTrimmedString,
  /** OpenRouter model ID sent to the API. */
  modelSlug: Schema.NonEmptyTrimmedString,
  /** Reasoning mode used for every sample. */
  reasoning: Schema.NonEmptyTrimmedString,
  trialsPerStep: Schema.Int.pipe(Schema.positive()),
  stepPercent: Schema.Int.pipe(Schema.between(1, 100)),
  startedAt: IsoTimestamp,
  points: Schema.Array(Point).pipe(Schema.minItems(1)),
}).pipe(
  Schema.filter((run) => run.points.every((point) => point.outcomes.length === run.trialsPerStep), {
    message: () => "Every point must contain trialsPerStep outcomes",
  }),
  Schema.filter((run) => new Set(run.points.map((point) => point.x)).size === run.points.length, {
    message: () => "Target probabilities must be unique within a run",
  }),
);
export type Run = typeof Run.Type;

/**
 * The append-only history document. Models can repeat; execution IDs cannot.
 * Decoding ignores unknown keys.
 */
export const Results = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  runs: Schema.Array(Run),
}).pipe(
  Schema.filter(
    (results) => new Set(results.runs.map((run) => run.id)).size === results.runs.length,
    { message: () => "Run ids must be unique within results" },
  ),
);
export type Results = typeof Results.Type;

/** Results as pretty-printed JSON: the on-disk format. */
export const ResultsJson = Schema.parseJson(Results, { space: 2 });
