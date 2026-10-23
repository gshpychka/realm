import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import {
  type NotebookView,
  notebookSearch,
  pinnedView,
  readNotebookView,
  toggleHidden,
} from "./notebook-view";

describe("Notebook addresses", () => {
  it("opens unknown views safely and keeps the default address clean", () => {
    const view = readNotebookView("?view=unknown&intervals=perhaps");
    expect(view.tab).toBe("calibration");
    expect(view.intervals).toBe(true);
    expect(notebookSearch(view)).toBe("");
  });
  it("restores exact runs, comparison selections, filters and uncertainty settings", () => {
    const view = {
      tab: "history" as const,
      runId: "run:a/b?2025-01-01T00:00:00.000Z",
      comparisons: ["run?one&two", "different run"],
      hidden: ["vendor/model:free", "模型/一"],
      query: "model + reasoning=low",
      intervals: false,
    };
    expect(readNotebookView(notebookSearch(view))).toEqual(view);
  });
  it("replaces owned parameters while preserving unrelated query parameters", () => {
    const next = readNotebookView("?view=method&hide=a&hide=a&compare=b&compare=b");
    const search = notebookSearch(next, "?campaign=example&view=history&q=old&run=old");
    expect(new URLSearchParams(search).get("campaign")).toBe("example");
    expect(readNotebookView(search)).toEqual(next);
    expect(next.hidden).toEqual(["a"]);
    expect(next.comparisons).toEqual(["b"]);
  });
});

describe("toggleHidden", () => {
  it("hides a shown model and shows a hidden one", () => {
    expect(toggleHidden(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleHidden(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("pinnedView", () => {
  const old = makeRun({ id: "old", model: "a" });
  const latest = makeRun({ id: "new", model: "a", startedAt: "2026-10-22T00:00:00.000Z" });
  const other = makeRun({ id: "other", model: "b" });
  const runs = [old, other, latest];
  const view = readNotebookView("");

  it("names each model's shown run on the calibration tab, hidden models included", () => {
    expect(pinnedView(runs, { ...view, hidden: ["b"] })).toEqual({ comparisons: ["new", "other"] });
    expect(pinnedView(runs, { ...view, comparisons: ["old"] })).toEqual({
      comparisons: ["old", "other"],
    });
  });

  it("names the inspected run on the history tab", () => {
    const history: NotebookView = { ...view, tab: "history" };
    expect(pinnedView(runs, history)).toEqual({ runId: "new" });
    expect(pinnedView(runs, { ...history, runId: "old" })).toEqual({ runId: "old" });
    expect(pinnedView(runs, { ...history, hidden: ["a", "b"] })).toEqual({ runId: null });
  });

  it("leaves the method tab as it is", () => {
    expect(pinnedView(runs, { ...view, tab: "method" })).toEqual({});
  });
});
