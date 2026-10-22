import { describe, expect, it } from "@effect/vitest";
import { PersistedResults as Results } from "@probabench/domain";
import * as Schema from "effect/Schema";
import { buildChartModel, MODEL_COLORS, modelColors, modelDash, REFERENCE_KEY } from "./chart-data";

const fixture = Schema.decodeUnknownSync(Results)({
  schemaVersion: 1,
  runs: [
    {
      model: "claude-haiku-4.5",
      trialsPerStep: 2,
      stepPercent: 50,
      startedAt: "2026-06-26T00:00:00.000Z",
      points: [
        { x: 0, rmse: 0, outcomes: [0, 0] },
        { x: 0.5, rmse: 0.5, outcomes: [1, { invalidText: "x" }] },
        { x: 1, rmse: null, outcomes: [{ invalidText: "nope" }, { invalidText: "x" }] },
      ],
    },
    {
      model: "claude-sonnet-4.5-high",
      trialsPerStep: 2,
      stepPercent: 50,
      startedAt: "2026-06-26T00:00:00.000Z",
      points: [
        { x: 0, rmse: Math.sqrt(0.5), outcomes: [1, 0] },
        { x: 1, rmse: 0, outcomes: [1, 1] },
      ],
    },
  ],
});

describe("model colours", () => {
  const runs = Array.from({ length: MODEL_COLORS.length + 1 }, (_, index) => ({
    model: `model-${index}`,
  }));

  it("gives each model a distinct palette entry before reusing colours", () => {
    const colors = modelColors(runs);
    expect(new Set([...colors.values()].slice(0, MODEL_COLORS.length)).size).toBe(
      MODEL_COLORS.length,
    );
    expect(colors.get("model-0")).toBe(colors.get(`model-${MODEL_COLORS.length}`));
    expect(modelDash("model-0", colors)).toBeUndefined();
    expect(modelDash(`model-${MODEL_COLORS.length}`, colors)).toBe("8 4");
  });

  it("keeps existing assignments when models repeat or new models append", () => {
    const initial = modelColors(runs.slice(0, 3));
    const appended = modelColors([...runs.slice(0, 3), { model: "model-1" }, ...runs.slice(3)]);
    for (const [model, color] of initial) expect(appended.get(model)).toBe(color);
    expect([...appended.keys()]).toEqual(runs.map((run) => run.model));
  });
});

describe("buildChartModel", () => {
  const model = buildChartModel(fixture);

  it("assigns opaque chart keys and stable model labels/colors", () => {
    expect(model.series.map((series) => series.key)).toEqual(["series_0", "series_1"]);
    expect(model.series.map((series) => series.label)).toEqual([
      "claude-haiku-4.5",
      "claude-sonnet-4.5-high",
    ]);
    expect(new Set(model.series.map((series) => series.color)).size).toBe(2);
  });

  it("plots observed rates rather than the stored RMSE on the sorted x grid", () => {
    expect(model.rows.map((row) => row.x)).toEqual([0, 0.5, 1]);
    expect(model.rows.map((row) => row[REFERENCE_KEY])).toEqual([0, 0.5, 1]);
    expect(model.rows[0]?.series_1).toBe(0.5);
    expect(model.rows[1]?.series_0).toBe(1);
    expect(model.rows[1]?.series_1).toBeNull();
    expect(model.rows[2]?.series_0).toBeNull();
    expect(model.rows[2]?.series_1).toBe(1);
  });

  it("reports ones over valid trials, invalids separately, and valid/total legend counts", () => {
    expect(model.meta.get(0.5)?.get("series_0")).toMatchObject({
      ones: 1,
      invalid: 1,
      valid: 1,
      total: 2,
      observed: 1,
      error: 0.5,
      rmse: 0.5,
    });
    expect(model.meta.get(1)?.get("series_0")).toMatchObject({
      ones: 0,
      invalid: 2,
      valid: 0,
      total: 2,
      observed: null,
      error: null,
      rmse: null,
      interval: null,
    });
    expect(model.series[0]).toMatchObject({ valid: 3, total: 6 });
  });

  it("includes Wilson confidence interval error-bar distances", () => {
    const interval = model.meta.get(0)?.get("series_1")?.interval;
    if (!interval) throw new Error("Expected a confidence interval for valid trials");
    expect(interval?.[0]).toBeLessThan(0.5);
    expect(interval?.[1]).toBeGreaterThan(0.5);
    expect(model.rows[0]?.series_1_interval).toEqual([0.5 - interval[0], interval[1] - 0.5]);
    expect(model.rows[2]?.series_0_interval).toBeNull();
  });

  it("avoids model ids colliding with structural keys, object prototypes, and Recharts dotted paths", () => {
    const results = Schema.decodeUnknownSync(Results)({
      schemaVersion: 1,
      runs: ["x", "reference", "__proto__", "a.b"].map((model) => ({ ...fixture.runs[0], model })),
    });
    const shaped = buildChartModel(results);
    expect(shaped.rows[1]?.x).toBe(0.5);
    expect(shaped.rows[1]?.reference).toBe(0.5);
    expect(shaped.series.map((series) => shaped.rows[1]?.[series.key])).toEqual([1, 1, 1, 1]);
    expect(shaped.series.map((series) => series.label)).toEqual([
      "x",
      "reference",
      "__proto__",
      "a.b",
    ]);
  });

  it("keeps a complete diagonal reference for a sparse or empty document", () => {
    const results = Schema.decodeUnknownSync(Results)({ schemaVersion: 1, runs: [] });
    expect(buildChartModel(results).rows).toEqual([
      { x: 0, reference: 0 },
      { x: 1, reference: 1 },
    ]);
  });

  it("uses each run's actual grid so another model's targets do not break its line", () => {
    expect(model.seriesRows.get("series_0")?.map((row) => row.x)).toEqual([0, 0.5, 1]);
    expect(model.seriesRows.get("series_1")?.map((row) => row.x)).toEqual([0, 1]);
    // A sampled all-invalid point is retained, so it still creates a real gap.
    expect(model.seriesRows.get("series_0")?.at(-1)?.series_0).toBeNull();
  });

  it("sorts a run's points independently and does not invent samples at reference endpoints", () => {
    const results = Schema.decodeUnknownSync(Results)({
      schemaVersion: 1,
      runs: [
        { ...fixture.runs[0], points: [fixture.runs[0]?.points[1], fixture.runs[0]?.points[0]] },
      ],
    });
    const shaped = buildChartModel(results);
    expect(shaped.rows.map((row) => row.x)).toEqual([0, 0.5, 1]);
    expect(shaped.seriesRows.get("series_0")?.map((row) => row.x)).toEqual([0, 0.5]);
  });
});
