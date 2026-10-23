// The shared results contract. This package stays independent of platform, AI and UI code.
import * as Schema from "effect/Schema";

export const SCHEMA_VERSION = 2;

const PositiveInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isSafeInteger(value) && value > 0, {
    message: () => "Expected a positive safe integer",
  }),
);
const NonBlankString = Schema.String.pipe(Schema.filter((value) => value.trim().length > 0));

/** A target probability as a fraction in [0, 1]. */
export const Probability = Schema.Number.pipe(
  Schema.finite(),
  Schema.between(0, 1),
  Schema.brand("Probability"),
);
export type Probability = typeof Probability.Type;

/** One sample: a bit, or the raw text of an unparseable reply. */
export const Trial = Schema.Union(
  Schema.Literal(0, 1),
  Schema.Struct({ invalidText: Schema.String }),
);
export type Trial = typeof Trial.Type;

/** Every sample taken at one target probability. */
export const Point = Schema.Struct({
  x: Probability,
  outcomes: Schema.Array(Trial),
});
export type Point = typeof Point.Type;

/** One immutable sweep. `id` identifies this execution; repeated model labels preserve history. */
export const Run = Schema.Struct({
  id: NonBlankString,
  model: NonBlankString,
  modelSlug: NonBlankString,
  reasoning: NonBlankString,
  trialsPerStep: PositiveInteger,
  stepPercent: PositiveInteger.pipe(Schema.lessThanOrEqualTo(100)),
  startedAt: Schema.String.pipe(
    Schema.filter(
      (value) => {
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
      },
      { message: () => "Expected an ISO UTC timestamp as emitted by Date.toISOString()" },
    ),
  ),
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
    {
      message: () => "Run ids must be unique within results",
    },
  ),
);
export type Results = typeof Results.Type;

/** Results as pretty-printed JSON: the on-disk format. */
export const ResultsJson = Schema.parseJson(Results, { space: 2 });
