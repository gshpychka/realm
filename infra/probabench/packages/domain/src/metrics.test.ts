import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { calibrationError, counts, observedRate, rateInterval, summarizeRun } from "./metrics";
import { Run, type Trial } from "./schema";

describe("empirical calibration", () => {
  it("uses only valid bits as the denominator", () => {
    const outcomes = [1, 0, { invalidText: "oops" }] as const;
    expect(observedRate(outcomes)).toBe(0.5);
    expect(calibrationError(outcomes, 0.25)).toBe(0.25);
  });

  it("returns null when all replies are invalid or missing", () => {
    expect(observedRate([])).toBeNull();
    expect(observedRate([{ invalidText: "x" }])).toBeNull();
    expect(calibrationError([{ invalidText: "x" }], 0.5)).toBeNull();
  });
});

describe("counts", () => {
  it("tallies ones, zeros, and invalids in a mixed array", () => {
    const outcomes: ReadonlyArray<Trial> = [
      1,
      0,
      1,
      { invalidText: "oops" },
      0,
      { invalidText: "" },
    ];
    expect(counts(outcomes)).toEqual({ ones: 2, zeros: 2, invalid: 2 });
  });

  it("is all-zero for an empty array", () => {
    expect(counts([])).toEqual({ ones: 0, zeros: 0, invalid: 0 });
  });
});

describe("rateInterval", () => {
  it("gives the Wilson interval for 50 ones in 100 valid trials", () => {
    const interval = rateInterval([...Array<Trial>(50).fill(1), ...Array<Trial>(50).fill(0)]);
    expect(interval?.[0]).toBeCloseTo(0.4038315, 6);
    expect(interval?.[1]).toBeCloseTo(0.5961685, 6);
  });

  it("keeps uncertainty at observed endpoints and ignores invalid replies", () => {
    const interval = rateInterval(Array<Trial>(100).fill(0));
    expect(interval?.[0]).toBe(0);
    expect(interval?.[1]).toBeCloseTo(0.0369935, 6);
    expect(rateInterval([1, { invalidText: "x" }])).toEqual(rateInterval([1]));
    expect(rateInterval([{ invalidText: "x" }])).toBeNull();
  });
});

describe("summarizeRun", () => {
  const makeRun = (points: readonly { x: number; outcomes: readonly Trial[] }[]) =>
    Schema.decodeUnknownSync(Run)({
      id: "execution-1",
      model: "model",
      trialsPerStep: 4,
      stepPercent: 50,
      startedAt: "2026-06-26T00:00:00.000Z",
      points,
    });

  it("weights covered target points equally and reports missing valid data separately", () => {
    const run = makeRun([
      { x: 0, outcomes: [0, 0, 0, 0] },
      { x: 0.5, outcomes: [1, 1, { invalidText: "x" }, { invalidText: "y" }] },
      { x: 1, outcomes: Array<Trial>(4).fill({ invalidText: "x" }) },
    ]);
    expect(summarizeRun(run)).toEqual({
      calibrationError: 0.25,
      valid: 6,
      invalid: 6,
      total: 12,
      validity: 0.5,
      coveredPoints: 2,
      totalPoints: 3,
      coverage: 2 / 3,
    });
  });

  it("does not award zero calibration error to an all-invalid run", () => {
    const invalid = Array<Trial>(4).fill({ invalidText: "x" });
    const summary = summarizeRun(
      makeRun([
        { x: 0, outcomes: invalid },
        { x: 1, outcomes: invalid },
      ]),
    );
    expect(summary).toEqual({
      calibrationError: null,
      valid: 0,
      invalid: 8,
      total: 8,
      validity: 0,
      coveredPoints: 0,
      totalPoints: 2,
      coverage: 0,
    });
  });

  it("reports zero error with complete coverage and validity for matched frequencies", () => {
    const summary = summarizeRun(
      makeRun([
        { x: 0, outcomes: [0, 0, 0, 0] },
        { x: 0.5, outcomes: [0, 1, 0, 1] },
        { x: 1, outcomes: [1, 1, 1, 1] },
      ]),
    );
    expect(summary).toMatchObject({
      calibrationError: 0,
      valid: 12,
      total: 12,
      validity: 1,
      coverage: 1,
    });
  });

  it("defines coverage over recorded points so partial-grid interpretation stays explicit", () => {
    const summary = summarizeRun(makeRun([{ x: 0.25, outcomes: [0, 0, 0, 1] }]));
    expect(summary).toMatchObject({
      calibrationError: 0,
      coveredPoints: 1,
      totalPoints: 1,
      coverage: 1,
    });
  });
});
