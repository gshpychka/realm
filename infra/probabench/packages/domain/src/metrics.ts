// Pure calibration metrics over the shared Trial contract.
// Pure domain: no node/platform/AI/React imports.
import type { Run, Trial } from "./schema";

/** The fraction of valid replies that are 1, or null when no valid replies were sampled. */
export const observedRate = (outcomes: ReadonlyArray<Trial>): number | null => {
  const { ones, zeros } = counts(outcomes);
  const valid = ones + zeros;
  return valid === 0 ? null : ones / valid;
};

/** Absolute empirical calibration error. Sampling noise remains even for a calibrated model. */
export const calibrationError = (outcomes: ReadonlyArray<Trial>, x: number): number | null => {
  const observed = observedRate(outcomes);
  return observed === null ? null : Math.abs(observed - x);
};

/** 95% Wilson score interval for the 1-rate, assuming independent, identically distributed valid samples. */
export const rateInterval = (outcomes: ReadonlyArray<Trial>): readonly [number, number] | null => {
  const { ones, zeros } = counts(outcomes);
  const n = ones + zeros;
  if (n === 0) return null;
  const p = ones / n;
  const z2 = 1.959963984540054 ** 2;
  const scale = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / scale;
  const halfWidth = Math.sqrt((z2 * p * (1 - p)) / n + z2 ** 2 / (4 * n ** 2)) / scale;
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
};

/** Tally of how the trials resolved. */
export interface Counts {
  readonly ones: number;
  readonly zeros: number;
  readonly invalid: number;
}

/** Counts of 1-bits, 0-bits, and invalid replies in an outcomes array. */
export const counts = (outcomes: ReadonlyArray<Trial>): Counts => {
  let ones = 0;
  let zeros = 0;
  let invalid = 0;
  for (const trial of outcomes) {
    if (trial === 1) ones++;
    else if (trial === 0) zeros++;
    else invalid++;
  }
  return { ones, zeros, invalid };
};

export interface RunSummary {
  /** Mean absolute calibration error across recorded points with at least one valid reply, as a fraction. */
  readonly calibrationError: number | null;
  readonly valid: number;
  readonly invalid: number;
  readonly total: number;
  /** Fraction of sampled replies that are valid bits. */
  readonly validity: number;
  readonly coveredPoints: number;
  readonly totalPoints: number;
  /** Fraction of recorded target points with valid replies; this does not measure planned-grid completeness. */
  readonly coverage: number;
}

/**
 * Summarize a sweep without hiding failures. Each covered probability point has
 * equal weight, so higher validity at one target cannot dominate the calibration
 * score. All-invalid targets are omitted from error and reflected in coverage.
 * Finite-sample noise remains; compare runs together with coverage and validity.
 */
export const summarizeRun = (run: Run): RunSummary => {
  let valid = 0;
  let invalid = 0;
  let coveredPoints = 0;
  let totalError = 0;
  for (const point of run.points) {
    const tally = counts(point.outcomes);
    const validAtPoint = tally.ones + tally.zeros;
    valid += validAtPoint;
    invalid += tally.invalid;
    if (validAtPoint > 0) {
      coveredPoints++;
      totalError += Math.abs(tally.ones / validAtPoint - point.x);
    }
  }
  const total = valid + invalid;
  const totalPoints = run.points.length;
  return {
    calibrationError: coveredPoints === 0 ? null : totalError / coveredPoints,
    valid,
    invalid,
    total,
    validity: total === 0 ? 0 : valid / total,
    coveredPoints,
    totalPoints,
    coverage: totalPoints === 0 ? 0 : coveredPoints / totalPoints,
  };
};
