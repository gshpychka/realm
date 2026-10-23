import type { Run } from "@probabench/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { inspectedRun, modelSelections, visibleHistory } from "../common/run-history";

export const TABS = ["calibration", "history", "method"] as const;
export type Tab = (typeof TABS)[number];

/** DOM ids: each tab button, and the panel they control (the skip link's target too). */
export const tabId = (tab: Tab): string => `tab-${tab}`;
export const PANEL_ID = "notebook-content";

export interface NotebookView {
  readonly tab: Tab;
  readonly runId: string | null;
  readonly comparisons: readonly string[];
  readonly hidden: readonly string[];
  readonly query: string;
  readonly intervals: boolean;
}

export type UpdateView = (patch: Partial<NotebookView>, mode?: "push" | "replace") => void;

/** URL parameter names; notebookSearch replaces exactly these and keeps any others. */
const PARAM = {
  tab: "view",
  runId: "run",
  comparisons: "compare",
  hidden: "hide",
  query: "q",
  intervals: "intervals",
} as const satisfies Record<keyof NotebookView, string>;

const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

/** The address is the notebook's view state, so links and browser navigation agree. */
export function readNotebookView(search: string): NotebookView {
  const params = new URLSearchParams(search);
  return {
    tab: TABS.find((tab) => tab === params.get(PARAM.tab)) ?? "calibration",
    runId: params.get(PARAM.runId) || null,
    comparisons: unique(params.getAll(PARAM.comparisons)),
    hidden: unique(params.getAll(PARAM.hidden)),
    query: params.get(PARAM.query) ?? "",
    intervals: params.get(PARAM.intervals) !== "0",
  };
}

export function notebookSearch(view: NotebookView, current = ""): string {
  const params = new URLSearchParams(current);
  for (const key of Object.values(PARAM)) params.delete(key);
  if (view.tab !== "calibration") params.set(PARAM.tab, view.tab);
  if (view.runId) params.set(PARAM.runId, view.runId);
  for (const id of unique(view.comparisons)) params.append(PARAM.comparisons, id);
  for (const model of unique(view.hidden)) params.append(PARAM.hidden, model);
  if (view.query) params.set(PARAM.query, view.query);
  if (!view.intervals) params.set(PARAM.intervals, "0");
  const search = params.toString();
  return search ? `?${search}` : "";
}

export const toggleHidden = (hidden: readonly string[], model: string): string[] =>
  hidden.includes(model) ? hidden.filter((item) => item !== model) : [...hidden, model];

/**
 * The view with the runs it shows named explicitly, so a shared link keeps showing
 * them instead of following runs saved later.
 */
export const pinnedView = (runs: readonly Run[], view: NotebookView): Partial<NotebookView> => {
  switch (view.tab) {
    case "calibration":
      return {
        comparisons: modelSelections(runs, view.comparisons).map(({ selected }) => selected.id),
      };
    case "history": {
      const visible = visibleHistory(runs, view.query, view.hidden);
      return { runId: inspectedRun(visible, view.runId)?.id ?? null };
    }
    case "method":
      return {};
  }
};

export function useNotebookView(): readonly [NotebookView, UpdateView] {
  const [view, setView] = useState(() => readNotebookView(window.location.search));
  // Updates build on this rather than on a render's `view`, so several updates in one
  // event all apply, and each rewrites the address before it returns.
  const current = useRef(view);
  useEffect(() => {
    const restore = () => {
      current.current = readNotebookView(window.location.search);
      setView(current.current);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const update = useCallback<UpdateView>((patch, mode = "push") => {
    const next = { ...current.current, ...patch };
    const search = notebookSearch(next, window.location.search);
    if (search !== window.location.search) {
      window.history[mode === "push" ? "pushState" : "replaceState"](
        null,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
    }
    current.current = next;
    setView(next);
  }, []);
  return [view, update];
}
