// Calibration metrics over the results contract.
import type { Outcome, Point, Run } from "./schema";

/** Two-sided 95% standard-normal quantile. */
const Z_95 = 1.959963984540054;

/** How a point's outcomes resolved. */
export interface Tally {
  readonly ones: number;
  readonly zeros: number;
  readonly invalid: number;
}

const tally = (outcomes: ReadonlyArray<Outcome>): Tally => {
  let ones = 0;
  let zeros = 0;
  let invalid = 0;
  for (const outcome of outcomes) {
    if (outcome === 1) ones++;
    else if (outcome === 0) zeros++;
    else invalid++;
  }
  return { ones, zeros, invalid };
};

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
export interface PointMeasurement extends Tally {
  readonly valid: number;
  readonly total: number;
  /** Fraction of valid outcomes that are 1. */
  readonly observed: number | null;
  readonly interval: readonly [number, number] | null;
  /** Absolute calibration error; sampling noise keeps it above 0 even for a calibrated model. */
  readonly error: number | null;
}

export const measurePoint = ({ x, outcomes }: Point): PointMeasurement => {
  const counted = tally(outcomes);
  const valid = counted.ones + counted.zeros;
  const measured = { ...counted, valid, total: outcomes.length };
  if (valid === 0) return { ...measured, observed: null, interval: null, error: null };
  const observed = counted.ones / valid;
  return {
    ...measured,
    observed,
    interval: wilson95(counted.ones, valid),
    error: Math.abs(observed - x),
  };
};

export interface RunSummary {
  /** Mean absolute calibration error over the points with a valid outcome, as a fraction. */
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
 * Summarize a sweep without hiding failures. Each covered point has equal weight,
 * so higher validity at one target cannot dominate the score. All-invalid points
 * are left out of the error and show up in coveredPoints instead. Finite-sample
 * noise remains; compare runs together with coverage and validity.
 */
export const summarizeRun = (run: Run): RunSummary => {
  const measured = run.points.map(measurePoint);
  const errors = measured.flatMap((point) => (point.error === null ? [] : [point.error]));
  const valid = measured.reduce((sum, point) => sum + point.valid, 0);
  const total = measured.reduce((sum, point) => sum + point.total, 0);
  return {
    meanCalibrationError:
      errors.length === 0 ? null : errors.reduce((sum, error) => sum + error, 0) / errors.length,
    valid,
    total,
    // A decoded Run has at least one point with trialsPerStep ≥ 1 outcomes, so total ≥ 1.
    validity: valid / total,
    coveredPoints: errors.length,
    totalPoints: run.points.length,
  };
};
