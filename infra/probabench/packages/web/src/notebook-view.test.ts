import { describe, expect, it } from "@effect/vitest";
import { notebookSearch, readNotebookView } from "./notebook-view";

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
