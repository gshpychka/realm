// Model evidence combines samples independently of how collection was batched.
import type { ReasoningMode } from "../plan/models";
import type { Probability } from "../plan/sampling";
import {
  type MeasurementSummary,
  measureCounts,
  measurePoint,
  type PointMeasurement,
  summarizeMeasurements,
} from "./metrics";
import type { Run } from "./schema";

export interface EvidencePoint extends PointMeasurement {
  readonly x: Probability;
}

/** All observations of one model with the same reasoning setting. */
export interface ModelEvidence {
  readonly model: string;
  readonly modelSlug: string;
  readonly reasoning: ReasoningMode;
  readonly firstCollectedAt: string;
  readonly lastCollectedAt: string;
  readonly points: readonly EvidencePoint[];
  readonly summary: MeasurementSummary;
}

/** Cumulative evidence at the end of a UTC collection day, never a batch score. */
export interface EvidenceCheckpoint {
  readonly model: string;
  readonly day: string;
  readonly summary: MeasurementSummary;
}

type Counts = { ones: number; zeros: number; invalid: number };
interface Accumulator {
  readonly model: string;
  readonly modelSlug: string;
  readonly reasoning: ReasoningMode;
  firstCollectedAt: string;
  lastCollectedAt: string;
  readonly targets: Map<Probability, Counts>;
}

const append = (models: Map<string, Accumulator>, record: Run): Accumulator => {
  let model = models.get(record.model);
  if (!model) {
    model = {
      model: record.model,
      modelSlug: record.modelSlug,
      reasoning: record.reasoning,
      firstCollectedAt: record.startedAt,
      lastCollectedAt: record.startedAt,
      targets: new Map(),
    };
    models.set(record.model, model);
  }
  if (record.startedAt < model.firstCollectedAt) model.firstCollectedAt = record.startedAt;
  if (record.startedAt > model.lastCollectedAt) model.lastCollectedAt = record.startedAt;
  for (const point of record.points) {
    const measured = measurePoint(point);
    const counts = model.targets.get(point.x) ?? { ones: 0, zeros: 0, invalid: 0 };
    counts.ones += measured.ones;
    counts.zeros += measured.zeros;
    counts.invalid += measured.invalid;
    model.targets.set(point.x, counts);
  }
  return model;
};

const pointsOf = (model: Accumulator): EvidencePoint[] =>
  [...model.targets]
    .sort(([a], [b]) => a - b)
    .map(([x, counts]) => ({ x, ...measureCounts(counts) }));

/**
 * Pool raw counts at each target before computing rates, intervals or calibration.
 * A small collection gets exactly its samples' weight; batch boundaries never matter.
 * `through` includes the entire UTC day. Historical inputs are never modified.
 */
export const collectEvidence = (
  records: readonly Run[],
  through: string | null = null,
): ModelEvidence[] => {
  const models = new Map<string, Accumulator>();
  for (const record of records) {
    if (through === null || record.startedAt.slice(0, 10) <= through) append(models, record);
  }
  return [...models.values()]
    .sort((a, b) => a.model.localeCompare(b.model))
    .map((model) => {
      const points = pointsOf(model);
      return {
        model: model.model,
        modelSlug: model.modelSlug,
        reasoning: model.reasoning,
        firstCollectedAt: model.firstCollectedAt,
        lastCollectedAt: model.lastCollectedAt,
        points,
        summary: summarizeMeasurements(points),
      };
    });
};

/**
 * One checkpoint per model per collection day. Grouping a day's data into one
 * invocation or many produces the same history. Counters grow incrementally;
 * history does not retain a copy of every preceding raw sample.
 */
export const evidenceHistory = (records: readonly Run[]): EvidenceCheckpoint[] => {
  const days = new Map<string, Run[]>();
  for (const record of records) {
    const day = record.startedAt.slice(0, 10);
    const items = days.get(day) ?? [];
    items.push(record);
    days.set(day, items);
  }
  const models = new Map<string, Accumulator>();
  const checkpoints: EvidenceCheckpoint[] = [];
  for (const [day, items] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const changed = new Set<string>();
    for (const record of items) changed.add(append(models, record).model);
    for (const model of [...changed].sort()) {
      const accumulated = models.get(model);
      if (accumulated)
        checkpoints.push({ model, day, summary: summarizeMeasurements(pointsOf(accumulated)) });
    }
  }
  return checkpoints;
};
