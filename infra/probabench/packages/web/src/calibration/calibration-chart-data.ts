// Each model's pooled evidence becomes a line on its own measured target grid.
import type { EvidencePoint, ModelEvidence, PointMeasurement } from "@probabench/domain";
import { type ModelStyle, styleOf } from "../common/palette";

export interface CalibrationPoint extends PointMeasurement {
  readonly x: number;
  /** Distances below and above observed, as Recharts' ErrorBar expects. */
  readonly errorBar: readonly [number, number] | null;
}

export interface CalibrationSeries {
  readonly model: string;
  readonly style: ModelStyle;
  /** Only this model's targets, so another model's grid never breaks this line. */
  readonly points: readonly CalibrationPoint[];
}

const measure = (point: EvidencePoint): CalibrationPoint => {
  const { observed, interval } = point;
  return {
    ...point,
    x: point.x,
    errorBar:
      observed !== null && interval !== null
        ? [observed - interval[0], interval[1] - observed]
        : null,
  };
};

export const buildCalibrationSeries = (
  evidence: readonly ModelEvidence[],
  styles: ReadonlyMap<string, ModelStyle>,
): CalibrationSeries[] =>
  evidence.map((item) => ({
    model: item.model,
    style: styleOf(styles, item.model),
    points: item.points.map(measure),
  }));
