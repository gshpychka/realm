import { describe, expect, it } from "@effect/vitest";
import type { Run } from "@probabench/domain";
import { makeRun } from "@probabench/domain/testing";
import { modelStyles } from "../common/palette";
import { buildHistoryChartModel } from "./history-chart-data";

type Points = (typeof Run.Encoded)["points"];
const invalid = { invalidText: "x" };
// Mean calibration errors of 0, 0.5 and none at all.
const calibrated: Points = [
  { x: 0, outcomes: [0, 0] },
  { x: 1, outcomes: [1, 1] },
];
const halfOff: Points = [
  { x: 0, outcomes: [0, 1] },
  { x: 1, outcomes: [0, 1] },
];
const allInvalid: Points = [
  { x: 0, outcomes: [invalid, invalid] },
  { x: 1, outcomes: [invalid, invalid] },
];

const run = (id: string, modelSlug: string, startedAt: string, points = calibrated) =>
  makeRun({ id, modelSlug, startedAt, points });
const styles = modelStyles([{ model: "vendor/model-a" }, { model: "vendor/model-b" }]);

describe("history chart measurements", () => {
  it("does not invent gaps for another model's intervening run but preserves all-invalid gaps", () => {
    const first = run("first", "vendor/model-a", "2026-10-22T15:00:00.000Z");
    const other = run("other", "vendor/model-b", "2026-10-22T15:01:00.000Z");
    const failed = run("invalid", "vendor/model-a", "2026-10-22T15:02:00.000Z", allInvalid);
    const last = run("last", "vendor/model-a", "2026-10-22T15:03:00.000Z", halfOff);
    const model = buildHistoryChartModel([last, first, other, failed], styles);
    const a = model.series.find((item) => item.model === "vendor/model-a");
    expect(a?.points.map((point) => point.run.id)).toEqual(["first", "invalid", "last"]);
    expect(a?.points.map((point) => point.summary.meanCalibrationError)).toEqual([0, null, 0.5]);
    expect(a?.style).toEqual(styles.get("vendor/model-a"));
  });

  it("pads a single run on both sides while keeping zero a valid error", () => {
    const item = run("only", "vendor/model-a", "2026-10-22T15:00:00.000Z");
    const model = buildHistoryChartModel([item], styles);
    expect(model.domain[0]).toBeLessThan(Date.parse(item.startedAt));
    expect(model.domain[1]).toBeGreaterThan(Date.parse(item.startedAt));
    expect(model.points[0]?.summary.meanCalibrationError).toBe(0);
    expect(model.yMax).toBe(0.05);
  });

  it("draws an empty history without points", () => {
    expect(buildHistoryChartModel([], styles).points).toEqual([]);
  });

  it.each([
    ["2026-10-22T18:30:00.000Z", "15:00"],
    ["2026-12-01T00:00:00.000Z", "Oct 22"],
    ["2027-12-01T00:00:00.000Z", "Oct 22, 26"],
  ])("labels ticks for a history ending %s as %s", (end, label) => {
    const model = buildHistoryChartModel(
      [
        run("first", "vendor/model-a", "2026-10-22T15:00:00.000Z"),
        run("last", "vendor/model-a", end),
      ],
      styles,
    );
    expect(model.tickFormat.format(Date.parse("2026-10-22T15:00:00.000Z"))).toBe(label);
  });
});
