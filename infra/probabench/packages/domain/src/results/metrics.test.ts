import { describe, expect, it } from "@effect/vitest";
import { Probability } from "../plan/sampling";
import { measurePoint, summarizeRun } from "./metrics";
import type { Outcome } from "./schema";
import { makeRun } from "./testing";

const invalid = { invalidText: "x" } as const;
const point = (x: number, outcomes: ReadonlyArray<Outcome>) => ({
  x: Probability.make(x),
  outcomes,
});

describe("measurePoint", () => {
  it.each([
    { ones: 50, zeros: 50, low: 0.4038315, high: 0.5961685 },
    { ones: 0, zeros: 100, low: 0, high: 0.0369935 },
  ])(
    "gives the 95% Wilson interval for $ones ones and $zeros zeros",
    ({ ones, zeros, low, high }) => {
      const outcomes = [...Array<Outcome>(ones).fill(1), ...Array<Outcome>(zeros).fill(0)];
      const interval = measurePoint(point(0.5, [...outcomes, invalid])).interval;
      expect(interval?.[0]).toBeCloseTo(low, 6);
      expect(interval?.[1]).toBeCloseTo(high, 6);
    },
  );
});

describe("summarizeRun", () => {
  it("weights covered points equally and reports missing valid data separately", () => {
    const run = makeRun({
      trialsPerStep: 4,
      stepPercent: 50,
      points: [
        { x: 0, outcomes: [0, 0, 0, 0] },
        { x: 0.5, outcomes: [1, 1, invalid, invalid] },
        { x: 1, outcomes: [invalid, invalid, invalid, invalid] },
      ],
    });
    expect(summarizeRun(run)).toEqual({
      meanCalibrationError: 0.25,
      valid: 6,
      total: 12,
      validity: 0.5,
      coveredPoints: 2,
      totalPoints: 3,
    });
  });

  it("does not award zero calibration error to an all-invalid run", () => {
    const run = makeRun({
      points: [
        { x: 0, outcomes: [invalid, invalid] },
        { x: 1, outcomes: [invalid, invalid] },
      ],
    });
    expect(summarizeRun(run)).toMatchObject({
      meanCalibrationError: null,
      validity: 0,
      coveredPoints: 0,
    });
  });
});
