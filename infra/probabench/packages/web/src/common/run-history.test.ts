import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { modelSelections, runsByDay, visibleHistory, withComparison } from "./run-history";

const old = makeRun({
  id: "old",
  modelSlug: "vendor/model-a",
  startedAt: "2026-10-20T00:00:00.000Z",
});
const other = makeRun({
  id: "other",
  modelSlug: "vendor/model-b",
  startedAt: "2026-10-21T00:00:00.000Z",
});
const latest = makeRun({
  id: "new",
  modelSlug: "vendor/model-a",
  startedAt: "2026-10-22T00:00:00.000Z",
});
const ids = (runs: readonly { readonly id: string }[]) => runs.map((run) => run.id);

describe("visibleHistory", () => {
  it("lists the shown models' runs, newest first", () => {
    const runs = [old, other, latest];
    expect(ids(visibleHistory(runs, []))).toEqual(["new", "other", "old"]);
    expect(ids(visibleHistory(runs, [other.model]))).toEqual(["new", "old"]);
    expect(visibleHistory(runs, [old.model, other.model])).toEqual([]);
  });
});

describe("modelSelections", () => {
  const runs = [old, other, latest];

  it("groups every run by model, newest first, and compares the latest by default", () => {
    const selections = modelSelections(runs, []);
    expect(selections.map((selection) => selection.model)).toEqual([old.model, other.model]);
    expect(ids(selections[0]?.runs ?? [])).toEqual(["new", "old"]);
    expect(selections.map((selection) => selection.compared.id)).toEqual(["new", "other"]);
  });

  it("keeps models in append order when a later model has the newest run", () => {
    expect(modelSelections([other, old, latest], []).map(({ model }) => model)).toEqual([
      other.model,
      old.model,
    ]);
  });

  it("compares the chosen run, and falls back to the latest when the comparison is missing", () => {
    expect(modelSelections(runs, ["old"]).map((selection) => selection.compared.id)).toEqual([
      "old",
      "other",
    ]);
    expect(modelSelections(runs, ["missing"]).map((selection) => selection.compared.id)).toEqual([
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
