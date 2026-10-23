// The persisted results contract.
import * as Schema from "effect/Schema";

export const SCHEMA_VERSION = 2;

/** A target probability as a fraction in [0, 1]. */
export const Probability = Schema.Number.pipe(Schema.between(0, 1), Schema.brand("Probability"));
export type Probability = typeof Probability.Type;

/** Reasoning a run requests from OpenRouter; "off" disables it. */
export const ReasoningMode = Schema.Literal("off", "low", "medium", "high", "xhigh");
export type ReasoningMode = typeof ReasoningMode.Type;
export type ReasoningEffort = Exclude<ReasoningMode, "off">;

/** Samples drawn at each target probability. */
export const TrialsPerStep = Schema.Int.pipe(Schema.positive());

/** Distance between neighbouring target probabilities, in whole percent. */
export const StepPercent = Schema.Int.pipe(Schema.between(1, 100));

/**
 * Target probabilities {0, step, 2·step, …, 100}% as fractions. Both endpoints are
 * always included, even when the step does not divide 100.
 */
export const probabilityGrid = (stepPercent: number): ReadonlyArray<Probability> =>
  [...Array.from({ length: Math.ceil(100 / stepPercent) }, (_, i) => i * stepPercent), 100].map(
    (percent) => Probability.make(percent / 100),
  );

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

/** One immutable run: a model series sampled over its full probability grid. */
export const Run = Schema.Struct({
  /** Unique in the history; a series keeps every earlier run. */
  id: Schema.NonEmptyTrimmedString,
  /**
   * Series key that groups runs: modelSlug, plus ` [reasoning=<mode>]` unless reasoning
   * is off. Written by the runner's modelLabel; display-only, never sent to the API.
   */
  model: Schema.NonEmptyTrimmedString,
  /** OpenRouter model ID sent to the API. */
  modelSlug: Schema.NonEmptyTrimmedString,
  /** Reasoning mode used for every sample. */
  reasoning: ReasoningMode,
  trialsPerStep: TrialsPerStep,
  stepPercent: StepPercent,
  startedAt: IsoTimestamp,
  points: Schema.Array(Point),
}).pipe(
  Schema.filter((run) => run.points.every((point) => point.outcomes.length === run.trialsPerStep), {
    message: () => "Every point must contain trialsPerStep outcomes",
  }),
  // Exact equality holds: the runner builds every x with probabilityGrid, and JSON
  // round-trips doubles exactly.
  Schema.filter(
    (run) => {
      const grid = probabilityGrid(run.stepPercent);
      return (
        run.points.length === grid.length && run.points.every((point, i) => point.x === grid[i])
      );
    },
    { message: () => "Points must be the stepPercent grid from 0 to 1, in order" },
  ),
);
export type Run = typeof Run.Type;

/**
 * The append-only history document. Models can repeat; run IDs cannot.
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
