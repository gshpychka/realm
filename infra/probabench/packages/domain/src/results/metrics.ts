// Calibration metrics over the results contract.
import type { Point, Run } from "./schema";

/** Two-sided 95% standard-normal quantile. */
const Z_95 = 1.959963984540054;

/** 95% Wilson score interval for `ones` successes in `valid` > 0 independent samples. */
const wilson95 = (ones: number, valid: number): readonly [number, number] => {
  const p = ones / valid;
  const z2 = Z_95 ** 2;
  const scale = 1 + z2 / valid;
  const center = (p + z2 / (2 * valid)) / scale;
  const halfWidth = Math.sqrt((z2 * p * (1 - p)) / valid + z2 ** 2 / (4 * valid ** 2)) / scale;
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
};

/**
 * What was measured at one target. Invalid outcomes are counted but excluded from
 * the rate, so the rate fields are null when no outcome is valid.
 */
export interface PointMeasurement {
  readonly ones: number;
  readonly zeros: number;
  readonly invalid: number;
  readonly valid: number;
  readonly total: number;
  /** Fraction of valid outcomes that are 1. */
  readonly observed: number | null;
  readonly interval: readonly [number, number] | null;
}

export const measureCounts = ({
  ones,
  zeros,
  invalid,
}: Pick<PointMeasurement, "ones" | "zeros" | "invalid">): PointMeasurement => {
  const valid = ones + zeros;
  const counts = { ones, zeros, invalid, valid, total: valid + invalid };
  return valid === 0
    ? { ...counts, observed: null, interval: null }
    : { ...counts, observed: ones / valid, interval: wilson95(ones, valid) };
};

export const measurePoint = ({ outcomes }: Point): PointMeasurement => {
  let ones = 0;
  let zeros = 0;
  for (const outcome of outcomes) {
    if (outcome === 1) ones++;
    else if (outcome === 0) zeros++;
  }
  return measureCounts({ ones, zeros, invalid: outcomes.length - ones - zeros });
};

export interface MeasurementSummary {
  /**
   * Mean absolute calibration error over the points with a valid outcome, as a
   * fraction. Sampling noise biases each point's error upward, so even a calibrated
   * model averages above 0.
   */
  readonly meanCalibrationError: number | null;
  readonly valid: number;
  readonly total: number;
  /** Fraction of outcomes that are valid bits. */
  readonly validity: number;
  /** Points with at least one valid outcome. */
  readonly coveredPoints: number;
  readonly totalPoints: number;
}

/**
 * Summarize measurements without hiding failures. Each covered point has equal weight,
 * so higher validity at one target cannot dominate the mean. All-invalid points
 * are left out of the error and show up in coveredPoints instead. Finite-sample
 * noise remains; compare models together with coverage and validity.
 */
export const summarizeMeasurements = (
  measured: readonly (PointMeasurement & { readonly x: number })[],
): MeasurementSummary => {
  const errors = measured.flatMap(({ x, observed }) =>
    observed === null ? [] : [Math.abs(observed - x)],
  );
  const valid = measured.reduce((sum, point) => sum + point.valid, 0);
  const total = measured.reduce((sum, point) => sum + point.total, 0);
  return {
    meanCalibrationError:
      errors.length === 0 ? null : errors.reduce((sum, error) => sum + error, 0) / errors.length,
    valid,
    total,
    validity: total === 0 ? 0 : valid / total,
    coveredPoints: errors.length,
    totalPoints: measured.length,
  };
};

/** The runner's summary of one saved storage record. */
export const summarizeRun = (run: Pick<Run, "points">): MeasurementSummary =>
  summarizeMeasurements(run.points.map((point) => ({ x: point.x, ...measurePoint(point) })));

/** A calibration error, given as a fraction, in percentage points; `empty` when there is none. */
export const calibrationErrorText = (value: number | null, empty = "—"): string =>
  value === null ? empty : `${(value * 100).toFixed(1)} pp`;
