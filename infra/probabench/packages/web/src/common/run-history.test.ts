import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import {
  inspectedRun,
  modelSelections,
  newestFirst,
  runsByDay,
  visibleHistory,
  withComparison,
} from "./run-history";

const old = makeRun({ id: "old", modelSlug: "vendor/model-a" });
const latest = makeRun({
  id: "new",
  modelSlug: "vendor/model-a",
  startedAt: "2026-10-22T00:00:00.000Z",
});
const other = makeRun({ id: "other", modelSlug: "vendor/model-b" });
const ids = (runs: readonly { readonly id: string }[]) => runs.map((run) => run.id);

describe("visibleHistory", () => {
  it("filters the archive consistently by model, metadata and visibility", () => {
    const noted = makeRun({
      id: "new",
      modelSlug: "vendor/specific-model",
      reasoning: "low",
      startedAt: latest.startedAt,
    });
    const runs = [old, noted, other];
    expect(ids(visibleHistory(runs, "  SPECIFIC  ", []))).toEqual(["new"]);
    expect(ids(visibleHistory(runs, "low", []))).toEqual(["new"]);
    expect(visibleHistory(runs, "specific", [noted.model])).toEqual([]);
    expect(visibleHistory(runs, "missing", [])).toEqual([]);
    expect(ids(visibleHistory(runs, "", [other.model]))).toEqual(["new", "old"]);
  });
});

describe("newestFirst", () => {
  it("uses append order when multiple runs have the same start timestamp", () => {
    const runs = [
      { ...old, id: "z-earlier" },
      { ...old, id: "a-later" },
    ];
    expect(ids(newestFirst(runs))).toEqual(["a-later", "z-earlier"]);
    expect(ids(runs)).toEqual(["z-earlier", "a-later"]);
  });
});

describe("modelSelections", () => {
  const runs = [old, other, latest];

  it("groups every run by model, newest first, and selects the latest by default", () => {
    const selections = modelSelections(runs, []);
    expect(selections.map((selection) => selection.model)).toEqual([old.model, other.model]);
    expect(ids(selections[0]?.runs ?? [])).toEqual(["new", "old"]);
    expect(selections.map((selection) => selection.selected.id)).toEqual(["new", "other"]);
  });

  it("selects a compared run, and falls back to the latest when the comparison is missing", () => {
    expect(modelSelections(runs, ["old"]).map((selection) => selection.selected.id)).toEqual([
      "old",
      "other",
    ]);
    expect(modelSelections(runs, ["missing"]).map((selection) => selection.selected.id)).toEqual([
      "new",
      "other",
    ]);
  });
});

describe("withComparison", () => {
  it("replaces the model's earlier comparison and keeps other models'", () => {
    expect(withComparison(["new", "other"], [old, other, latest], old)).toEqual(["other", "old"]);
  });
});

describe("inspectedRun", () => {
  it("shows the linked run while it is visible, else the newest visible run", () => {
    expect(inspectedRun([latest, old], "old")).toBe(old);
    expect(inspectedRun([latest, old], "hidden")).toBe(latest);
    expect(inspectedRun([], "old")).toBeUndefined();
  });
});

describe("runsByDay", () => {
  it("groups runs by UTC day and keeps their order", () => {
    const late = makeRun({ id: "late", startedAt: "2026-10-22T23:59:00.000Z" });
    const early = makeRun({ id: "early", startedAt: "2026-10-22T00:01:00.000Z" });
    const before = makeRun({ id: "before", startedAt: "2026-10-21T23:59:00.000Z" });
    expect(runsByDay([late, early, before]).map(([day, runs]) => [day, ids(runs)])).toEqual([
      ["2026-10-22", ["late", "early"]],
      ["2026-10-21", ["before"]],
    ]);
  });
});
