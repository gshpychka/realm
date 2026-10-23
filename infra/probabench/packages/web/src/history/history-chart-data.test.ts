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

const run = (id: string, model: string, startedAt: string, points = calibrated) =>
  makeRun({ id, model, startedAt, points });
const styles = modelStyles([{ model: "model-a" }, { model: "model-b" }]);

describe("history chart measurements", () => {
  it("keeps every execution when timestamps tie, including equal scores, in archive order", () => {
    const at = "2026-10-22T15:00:00.000Z";
    const original = run("z-old", "model-a", at);
    const newer = run("a-new", "model-a", at);
    const model = buildHistoryChartModel([original, newer], styles);
    expect(model.points.map((point) => point.run.id)).toEqual(["z-old", "a-new"]);
    expect(model.series[0]?.points).toHaveLength(2);
    expect(model.points.map((point) => point.timestamp)).toEqual([Date.parse(at), Date.parse(at)]);
  });

  it("does not invent gaps for another model's intervening run but preserves all-invalid gaps", () => {
    const first = run("first", "model-a", "2026-10-22T15:00:00.000Z");
    const other = run("other", "model-b", "2026-10-22T15:01:00.000Z");
    const failed = run("invalid", "model-a", "2026-10-22T15:02:00.000Z", allInvalid);
    const last = run("last", "model-a", "2026-10-22T15:03:00.000Z", halfOff);
    const model = buildHistoryChartModel([last, first, other, failed], styles);
    const a = model.series.find((item) => item.model === "model-a");
    expect(a?.points.map((point) => point.run.id)).toEqual(["first", "invalid", "last"]);
    expect(a?.points.map((point) => point.score)).toEqual([0, null, 0.5]);
    expect(a?.style).toEqual(styles.get("model-a"));
    expect(a?.points[1]?.summary).toMatchObject({ validity: 0, coveredPoints: 0 });
  });

  it("pads a single observation on both sides while keeping zero a valid score", () => {
    const item = run("only", "model-a", "2026-10-22T15:00:00.000Z");
    const model = buildHistoryChartModel([item], styles);
    expect(model.domain[0]).toBeLessThan(Date.parse(item.startedAt));
    expect(model.domain[1]).toBeGreaterThan(Date.parse(item.startedAt));
    expect(model.points[0]?.score).toBe(0);
    expect(model.upperScore).toBe(0.05);
  });

  it("keeps empty and all-invalid histories distinct without manufacturing a score", () => {
    expect(buildHistoryChartModel([], styles).points).toEqual([]);
    const model = buildHistoryChartModel(
      [run("invalid", "model-a", "2026-10-22T15:00:00.000Z", allInvalid)],
      styles,
    );
    expect(model.points[0]?.score).toBeNull();
    expect(model.points[0]?.summary.validity).toBe(0);
    expect(model.series[0]?.points).toHaveLength(1);
  });

  it.each([
    ["2026-10-22T18:30:00.000Z", "15:00"],
    ["2026-12-01T00:00:00.000Z", "Oct 22"],
    ["2027-12-01T00:00:00.000Z", "Oct 22, 26"],
  ])("labels ticks for a history ending %s as %s", (end, label) => {
    const model = buildHistoryChartModel(
      [run("first", "model-a", "2026-10-22T15:00:00.000Z"), run("last", "model-a", end)],
      styles,
    );
    expect(model.tickFormat.format(Date.parse("2026-10-22T15:00:00.000Z"))).toBe(label);
  });
});
