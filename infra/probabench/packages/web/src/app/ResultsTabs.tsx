import { type ResultsView, TABS, type Tab, type UpdateView } from "../common/results-view";

const TAB_LABELS = {
  calibration: "Results",
  history: "Over time",
  method: "Method",
} as const satisfies Record<Tab, string>;

export function ResultsTabs({ view, update }: { view: ResultsView; update: UpdateView }) {
  return (
    <nav className="results-navigation" aria-label="Results views">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          aria-current={view.tab === tab ? "page" : undefined}
          onClick={() => update({ tab, through: null })}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </nav>
  );
}
