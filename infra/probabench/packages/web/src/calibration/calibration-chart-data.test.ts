import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { modelStyles } from "../common/palette";
import { buildCalibrationSeries } from "./calibration-chart-data";

const haiku = makeRun({
  modelSlug: "vendor/haiku",
  stepPercent: 50,
  points: [
    { x: 0, outcomes: [0, 0] },
    { x: 0.5, outcomes: [1, { invalidText: "x" }] },
    { x: 1, outcomes: [{ invalidText: "nope" }, { invalidText: "x" }] },
  ],
});
const sonnet = makeRun({
  modelSlug: "vendor/sonnet",
  points: [
    { x: 0, outcomes: [1, 0] },
    { x: 1, outcomes: [1, 1] },
  ],
});
const runs = [haiku, sonnet];
const [haikuSeries, sonnetSeries] = buildCalibrationSeries(runs, modelStyles(runs));

describe("buildCalibrationSeries", () => {
  it("draws each run on its own target grid with its model's style", () => {
    expect(haikuSeries?.points.map((point) => point.x)).toEqual([0, 0.5, 1]);
    expect(sonnetSeries?.points.map((point) => point.x)).toEqual([0, 1]);
    expect(haikuSeries?.style).not.toEqual(sonnetSeries?.style);
  });

  it("plots the fraction of valid replies that are ones", () => {
    expect(haikuSeries?.points.map((point) => point.observed)).toEqual([0, 1, null]);
    expect(sonnetSeries?.points.map((point) => point.observed)).toEqual([0.5, 1]);
  });

  it("keeps an all-invalid point as a gap with its reply counts", () => {
    expect(haikuSeries?.points[2]).toMatchObject({
      ones: 0,
      valid: 0,
      invalid: 2,
      total: 2,
      observed: null,
      interval: null,
      errorBar: null,
    });
  });

  it("turns the Wilson interval into error-bar distances around the observed rate", () => {
    const point = sonnetSeries?.points[0];
    if (!point?.interval) throw new Error("Expected a confidence interval for valid replies");
    const [low, high] = point.interval;
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
    expect(point.errorBar).toEqual([0.5 - low, high - 0.5]);
  });
});
