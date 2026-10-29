// The persisted results contract.
import * as Schema from "effect/Schema";
import { ModelSlug, ReasoningMode } from "../plan/models";
import { Probability, probabilityGrid, StepPercent, TrialsPerStep } from "../plan/sampling";

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
 * Canonical Date.toISOString() form, so timestamps and UTC collection days sort
 * chronologically in the evidence projection.
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

/**
 * The series a run belongs to: its OpenRouter model ID, plus ` [reasoning=<mode>]`
 * unless reasoning is off.
 */
export const seriesLabel = (modelSlug: string, reasoning: ReasoningMode): string =>
  reasoning === "off" ? modelSlug : `${modelSlug} [reasoning=${reasoning}]`;

/** An immutable checkpoint containing newly collected answers for one model. */
export const Run = Schema.Struct({
  /** Unique in the history; a series keeps every earlier run. */
  id: Schema.NonEmptyTrimmedString,
  /**
   * Series key, always seriesLabel(modelSlug, reasoning): views group, colour and
   * filter the combined model evidence by it. Never sent to the API.
   */
  model: Schema.String,
  /** OpenRouter model ID sent to the API. */
  modelSlug: ModelSlug,
  /** Reasoning mode used for every sample. */
  reasoning: ReasoningMode,
  trialsPerStep: TrialsPerStep,
  stepPercent: StepPercent,
  startedAt: IsoTimestamp,
  points: Schema.Array(Point),
}).pipe(
  Schema.filter((run) => run.model === seriesLabel(run.modelSlug, run.reasoning), {
    message: () => "model must be seriesLabel(modelSlug, reasoning)",
  }),
  Schema.filter(
    (run) =>
      run.points.every(
        (point) => point.outcomes.length > 0 && point.outcomes.length <= run.trialsPerStep,
      ),
    {
      message: () => "Checkpoint points must contain between 1 and trialsPerStep outcomes",
    },
  ),
  // Exact equality holds: the runner builds every x with probabilityGrid, and JSON
  // round-trips doubles exactly.
  Schema.filter(
    (run) => {
      const grid = probabilityGrid(run.stepPercent);
      return (
        run.points.length > 0 &&
        run.points.every(
          (point, i) =>
            grid.includes(point.x) && (i === 0 || point.x > (run.points[i - 1]?.x ?? -1)),
        )
      );
    },
    { message: () => "Checkpoint points must be unique, ordered members of the requested grid" },
  ),
);
export type Run = typeof Run.Type;

/** The append-only history document. Models can repeat; run IDs cannot. */
export const Results = Schema.Struct({ runs: Schema.Array(Run) }).pipe(
  Schema.filter(
    (results) => new Set(results.runs.map((run) => run.id)).size === results.runs.length,
    { message: () => "Run ids must be unique within results" },
  ),
);
export type Results = typeof Results.Type;

/**
 * The history's file name. The runner writes it to the workspace's data/ folder,
 * which the web app serves as its site root.
 */
export const RESULTS_FILE = "results.json";
