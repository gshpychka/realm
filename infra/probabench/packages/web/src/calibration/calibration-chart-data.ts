// Each selected run becomes one line of measured points on its own target grid.
import { measurePoint, type Point, type PointMeasurement, type Run } from "@probabench/domain";
import { type ModelStyle, styleOf } from "../common/palette";

export interface CalibrationPoint extends PointMeasurement {
  readonly x: number;
  /** Distances below and above observed, as Recharts' ErrorBar expects. */
  readonly errorBar: readonly [number, number] | null;
}

export interface CalibrationSeries {
  readonly run: Run;
  readonly style: ModelStyle;
  /** Only this run's targets, so another run's grid never breaks this line. */
  readonly points: readonly CalibrationPoint[];
}

const measure = (point: Point): CalibrationPoint => {
  const measured = measurePoint(point);
  const { observed, interval } = measured;
  return {
    ...measured,
    x: point.x,
    errorBar:
      observed !== null && interval !== null
        ? [observed - interval[0], interval[1] - observed]
        : null,
  };
};

export const buildCalibrationSeries = (
  runs: readonly Run[],
  styles: ReadonlyMap<string, ModelStyle>,
): CalibrationSeries[] =>
  runs.map((run) => ({
    run,
    style: styleOf(styles, run.model),
    points: run.points.map(measure),
  }));
