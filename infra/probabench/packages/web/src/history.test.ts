import { describe, expect, it } from "@effect/vitest";
import { PersistedResults, type Run } from "@probabench/domain";
import * as Schema from "effect/Schema";
import { modelColors } from "./chart-data";
import { groupHistory, newestFirst, selectedRuns, visibleHistory } from "./history";

const legacy = Schema.decodeUnknownSync(PersistedResults)({
  schemaVersion: 1,
  runs: [
    {
      model: "model.a",
      trialsPerStep: 2,
      stepPercent: 50,
      startedAt: "2026-06-26T00:00:00.000Z",
      points: [{ x: 0.5, outcomes: [0, 1] }],
    },
  ],
}).runs[0];
if (!legacy) throw new Error("Missing fixture");
const old: Run = { ...legacy, id: "old" };
const latest: Run = { ...old, id: "new", startedAt: "2026-10-22T00:00:00.000Z" };
const other: Run = { ...old, id: "other", model: "__proto__" };

describe("History selection", () => {
  it("filters the archive consistently by model, metadata and visibility", () => {
    const noted = { ...latest, modelSlug: "vendor/specific-model", reasoning: "low" };
    const runs = [old, noted, other];
    expect(visibleHistory(runs, "  SPECIFIC  ", []).map((run) => run.id)).toEqual(["new"]);
    expect(visibleHistory(runs, "low", []).map((run) => run.id)).toEqual(["new"]);
    expect(visibleHistory(runs, "specific", [noted.model])).toEqual([]);
    expect(visibleHistory(runs, "missing", [])).toEqual([]);
    expect(visibleHistory(runs, "", [other.model]).map((run) => run.id)).toEqual(["new", "old"]);
  });
  it("uses append order when multiple runs have the same start timestamp", () => {
    const runs = [
      { ...old, id: "z-earlier" },
      { ...old, id: "a-later" },
    ];
    expect(newestFirst(runs).map((run) => run.id)).toEqual(["a-later", "z-earlier"]);
    expect(selectedRuns(groupHistory(runs), new Map(), new Set())[0]?.id).toBe("a-later");
    expect(runs[0]?.id).toBe("z-earlier");
  });
  it("defaults to the latest snapshot per model and preserves older runs", () => {
    const groups = groupHistory([latest, old, other]);
    expect(groups.find((group) => group.model === old.model)?.runs.map((run) => run.id)).toEqual([
      "new",
      "old",
    ]);
    expect(selectedRuns(groups, new Map(), new Set()).map((run) => run.id)).toEqual([
      "new",
      "other",
    ]);
    expect(
      selectedRuns(groups, new Map([[old.model, old.id]]), new Set()).map((run) => run.id),
    ).toEqual(["old", "other"]);
  });
  it("hides a model without deleting its selection and recovers from absent selections", () => {
    const groups = groupHistory([old, other, latest]);
    expect(
      selectedRuns(groups, new Map([[old.model, "missing"]]), new Set([other.model])).map(
        (run) => run.id,
      ),
    ).toEqual(["new"]);
    expect(selectedRuns(groups, new Map(), new Set([old.model, other.model]))).toEqual([]);
  });
  it("keeps model colours when new observations reorder the latest model groups", () => {
    const before = modelColors([old, other]);
    const after = modelColors([old, other, latest]);
    for (const group of groupHistory([old, other, latest]))
      expect(after.get(group.model)).toBe(before.get(group.model));
  });
});
