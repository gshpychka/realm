// The shared results contract. This package stays independent of platform, AI and UI code.
import * as Schema from "effect/Schema";
import { rmse } from "./metrics";

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

/** Samples at one target, with per-bit RMSE (null only when no replies are valid). */
export const Point = Schema.Struct({
  x: Probability,
  rmse: Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.between(0, 1))),
  outcomes: Schema.Array(Trial),
}).pipe(
  Schema.filter(
    (point) => {
      const expected = rmse(point.outcomes, point.x);
      return expected === null
        ? point.rmse === null
        : point.rmse !== null && Math.abs(point.rmse - expected) < 1e-10;
    },
    { message: () => "RMSE must match the valid outcomes (null only when none are valid)" },
  ),
);
export type Point = typeof Point.Type;

const RunFields = {
  model: NonBlankString,
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
};

const validTrialCounts = (run: {
  readonly trialsPerStep: number;
  readonly points: ReadonlyArray<Point>;
}): boolean => run.points.every((point) => point.outcomes.length === run.trialsPerStep);
const uniqueProbabilities = (run: { readonly points: ReadonlyArray<Point> }): boolean =>
  new Set(run.points.map((point) => point.x)).size === run.points.length;

/** One immutable sweep. `id` identifies this execution; repeated model labels preserve history. */
export const Run = Schema.Struct({
  id: NonBlankString,
  ...RunFields,
  modelSlug: Schema.optional(NonBlankString),
  reasoning: Schema.optional(NonBlankString),
}).pipe(
  Schema.filter((run) => validTrialCounts(run), {
    message: () => "Every point must contain trialsPerStep outcomes",
  }),
  Schema.filter((run) => uniqueProbabilities(run), {
    message: () => "Target probabilities must be unique within a run",
  }),
);
export type Run = typeof Run.Type;

/** The current append-only document. Models can repeat; execution IDs cannot. */
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

const LegacyRun = Schema.Struct(RunFields).pipe(
  Schema.filter((run) => validTrialCounts(run), {
    message: () => "Every point must contain trialsPerStep outcomes",
  }),
  Schema.filter((run) => uniqueProbabilities(run), {
    message: () => "Target probabilities must be unique within a run",
  }),
);
const LegacyResults = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runs: Schema.Array(LegacyRun),
}).pipe(
  Schema.filter(
    (results) => new Set(results.runs.map((run) => run.model)).size === results.runs.length,
    {
      message: () => "Model ids must be unique within version 1 results",
    },
  ),
);

/**
 * Read v1 or v2; always produce and encode v2. Legacy IDs are deterministic under
 * reordering. Length-prefixing the model prevents delimiter collisions without
 * platform crypto or URI encoding (which rejects lone UTF-16 surrogates).
 */
export const PersistedResults = Schema.transform(
  Schema.Union(Results, LegacyResults),
  Schema.typeSchema(Results),
  {
    strict: true,
    decode: (document): Results =>
      document.schemaVersion === SCHEMA_VERSION
        ? document
        : {
            schemaVersion: SCHEMA_VERSION,
            runs: document.runs.map((run) => ({
              ...run,
              id: `legacy-v1:${run.model.length}:${run.model}:${run.startedAt}`,
            })),
          },
    encode: (document) => document,
  },
);

/** Decode an already-parsed document, upgrading legacy history when needed. */
export const decodeResults = Schema.decodeUnknown(PersistedResults);
