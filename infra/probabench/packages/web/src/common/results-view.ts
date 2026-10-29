import { useCallback, useEffect, useRef, useState } from "react";

export const TABS = ["calibration", "history", "method"] as const;
export type Tab = (typeof TABS)[number];

/**
 * The DOM id of the panel that shows the current view: the skip link's target, and where
 * focus goes when a view change unmounts the focused button.
 */
export const PANEL_ID = "results-content";

export interface ResultsView {
  readonly tab: Tab;
  readonly model: string | null;
  /** Include all samples collected through this UTC day; null means all evidence. */
  readonly through: string | null;
  readonly hidden: readonly string[];
  readonly intervals: boolean;
}

export type UpdateView = (patch: Partial<ResultsView>, mode?: "push" | "replace") => void;

/** URL parameter names; resultsSearch replaces exactly these and keeps any others. */
const PARAM = {
  tab: "view",
  model: "model",
  through: "through",
  hidden: "hide",
  intervals: "intervals",
} as const satisfies Record<keyof ResultsView, string>;

const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];

const collectionDay = (value: string | null): string | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
};

/** The address stores the view state, so links and browser navigation agree. */
export function readResultsView(search: string): ResultsView {
  const params = new URLSearchParams(search);
  return {
    tab: TABS.find((tab) => tab === params.get(PARAM.tab)) ?? "calibration",
    model: params.get(PARAM.model) || null,
    through: collectionDay(params.get(PARAM.through)),
    hidden: unique(params.getAll(PARAM.hidden)),
    intervals: params.get(PARAM.intervals) !== "0",
  };
}

export function resultsSearch(view: ResultsView, current = ""): string {
  const params = new URLSearchParams(current);
  for (const key of Object.values(PARAM)) params.delete(key);
  if (view.tab !== "calibration") params.set(PARAM.tab, view.tab);
  if (view.model) params.set(PARAM.model, view.model);
  const through = collectionDay(view.through);
  if (through) params.set(PARAM.through, through);
  for (const model of unique(view.hidden)) params.append(PARAM.hidden, model);
  if (!view.intervals) params.set(PARAM.intervals, "0");
  const search = params.toString();
  return search ? `?${search}` : "";
}

export const toggleHidden = (hidden: readonly string[], model: string): string[] =>
  hidden.includes(model) ? hidden.filter((item) => item !== model) : [...hidden, model];

export function useResultsView(): readonly [ResultsView, UpdateView] {
  const [view, setView] = useState(() => readResultsView(window.location.search));
  // Updates build on this rather than on a render's `view`, so several updates in one
  // event all apply, and each rewrites the address before it returns.
  const current = useRef(view);
  useEffect(() => {
    const restore = () => {
      current.current = readResultsView(window.location.search);
      setView(current.current);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const update = useCallback<UpdateView>((patch, mode = "push") => {
    const next = { ...current.current, ...patch };
    const search = resultsSearch(next, window.location.search);
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
