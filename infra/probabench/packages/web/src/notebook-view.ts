import { useCallback, useEffect, useRef, useState } from "react";

export type Tab = "calibration" | "history" | "method";

export interface NotebookView {
  readonly tab: Tab;
  readonly runId: string | null;
  readonly comparisons: readonly string[];
  readonly hidden: readonly string[];
  readonly query: string;
  readonly intervals: boolean;
}

const VIEW_KEYS = ["view", "run", "compare", "hide", "q", "intervals"] as const;
const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

/** The address is the notebook's view state, so links and browser navigation agree. */
export function readNotebookView(search: string): NotebookView {
  const params = new URLSearchParams(search);
  const tab = params.get("view");
  return {
    tab: tab === "history" || tab === "method" ? tab : "calibration",
    runId: params.get("run") || null,
    comparisons: unique(params.getAll("compare")),
    hidden: unique(params.getAll("hide")),
    query: params.get("q") ?? "",
    intervals: params.get("intervals") !== "0",
  };
}

export function notebookSearch(view: NotebookView, current = ""): string {
  const params = new URLSearchParams(current);
  for (const key of VIEW_KEYS) params.delete(key);
  if (view.tab !== "calibration") params.set("view", view.tab);
  if (view.runId) params.set("run", view.runId);
  for (const id of unique(view.comparisons)) params.append("compare", id);
  for (const model of unique(view.hidden)) params.append("hide", model);
  if (view.query) params.set("q", view.query);
  if (!view.intervals) params.set("intervals", "0");
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function useNotebookView() {
  const [view, setView] = useState(() => readNotebookView(window.location.search));
  const current = useRef(view);
  useEffect(() => {
    const restore = () => {
      current.current = readNotebookView(window.location.search);
      setView(current.current);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const update = useCallback((patch: Partial<NotebookView>, mode: "push" | "replace" = "push") => {
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
  return [view, update] as const;
}
