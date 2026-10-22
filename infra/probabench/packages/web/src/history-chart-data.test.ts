import { describe, expect, it } from "@effect/vitest";
import { Probability, type Run, rmse, type Trial } from "@probabench/domain";
import { buildHistoryChartModel } from "./history-chart-data";

const run = (
  id: string,
  model: string,
  startedAt: string,
  outcomes: readonly Trial[] = [0, 1],
): Run => ({
  id,
  model,
  startedAt,
  trialsPerStep: outcomes.length,
  stepPercent: 50,
  points: [{ x: Probability.make(0.5), outcomes, rmse: rmse(outcomes, 0.5) }],
});
const colors = new Map([
  ["model-a", "#d8a657"],
  ["model-b", "#7daea3"],
]);

describe("history chart measurements", () => {
  it("keeps every execution when timestamps tie, including equal scores, in archive order", () => {
    const at = "2026-10-22T15:00:00.000Z";
    const original = run("z-old", "model-a", at);
    const newer = run("a-new", "model-a", at);
    const model = buildHistoryChartModel([original, newer], colors);
    expect(model.points.map((point) => point.run.id)).toEqual(["z-old", "a-new"]);
    expect(model.series[0]?.points).toHaveLength(2);
    expect(model.points.map((point) => point.timestamp)).toEqual([Date.parse(at), Date.parse(at)]);
  });

  it("does not invent gaps for another model's intervening run but preserves all-invalid gaps", () => {
    const first = run("first", "model-a", "2026-10-22T15:00:00.000Z");
    const other = run("other", "model-b", "2026-10-22T15:01:00.000Z");
    const invalid = run("invalid", "model-a", "2026-10-22T15:02:00.000Z", [{ invalidText: "x" }]);
    const last = run("last", "model-a", "2026-10-22T15:03:00.000Z", [1, 1]);
    const model = buildHistoryChartModel([last, first, other, invalid], colors);
    const a = model.series.find((item) => item.model === "model-a");
    expect(a?.points.map((point) => point.run.id)).toEqual(["first", "invalid", "last"]);
    expect(a?.points.map((point) => point.score)).toEqual([0, null, 0.5]);
    expect(a?.color).toBe(colors.get("model-a"));
    expect(a?.points[1]?.summary).toMatchObject({ validity: 0, coverage: 0 });
  });

  it("pads a single observation on both sides while keeping zero a valid score", () => {
    const item = run("only", "model-a", "2026-10-22T15:00:00.000Z");
    const model = buildHistoryChartModel([item], colors);
    expect(model.domain[0]).toBeLessThan(Date.parse(item.startedAt));
    expect(model.domain[1]).toBeGreaterThan(Date.parse(item.startedAt));
    expect(model.points[0]?.score).toBe(0);
    expect(model.upperScore).toBe(0.05);
  });

  it("keeps empty and all-invalid histories distinct without manufacturing a score", () => {
    expect(buildHistoryChartModel([], colors).points).toEqual([]);
    const model = buildHistoryChartModel(
      [run("invalid", "model-a", "2026-10-22T15:00:00.000Z", [{ invalidText: "x" }])],
      colors,
    );
    expect(model.points[0]?.score).toBeNull();
    expect(model.points[0]?.summary.validity).toBe(0);
    expect(model.series[0]?.points).toHaveLength(1);
  });
});
