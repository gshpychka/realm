import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { modelStyles } from "../common/palette";
import { buildCalibrationSeries } from "./calibration-chart-data";

const a = makeRun({
  modelSlug: "vendor/model-a",
  stepPercent: 50,
  points: [
    { x: 0, outcomes: [0, 0] },
    { x: 0.5, outcomes: [1, { invalidText: "x" }] },
    { x: 1, outcomes: [{ invalidText: "nope" }, { invalidText: "x" }] },
  ],
});
const b = makeRun({
  modelSlug: "vendor/model-b",
  points: [
    { x: 0, outcomes: [1, 0] },
    { x: 1, outcomes: [1, 1] },
  ],
});
const runs = [a, b];
const [aSeries, bSeries] = buildCalibrationSeries(runs, modelStyles(runs));

describe("buildCalibrationSeries", () => {
  it("draws each run on its own target grid with its model's style", () => {
    expect(aSeries?.points.map((point) => point.x)).toEqual([0, 0.5, 1]);
    expect(bSeries?.points.map((point) => point.x)).toEqual([0, 1]);
    expect(aSeries?.style).not.toEqual(bSeries?.style);
  });

  it("turns the Wilson interval into error-bar distances, and gives an all-invalid target none", () => {
    const point = bSeries?.points[0];
    if (!point?.interval) throw new Error("Expected a confidence interval for valid replies");
    const [low, high] = point.interval;
    expect(low).toBeLessThan(0.5);
    expect(high).toBeGreaterThan(0.5);
    expect(point.errorBar).toEqual([0.5 - low, high - 0.5]);
    expect(aSeries?.points[2]?.errorBar).toBeNull();
  });
});
