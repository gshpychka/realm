import { count } from "../common/format";
import { type NotebookView, TABS, type Tab, type UpdateView } from "./notebook-view";

const TAB_LABELS = {
  calibration: "Calibration",
  history: "Run history",
  method: "Method",
} as const satisfies Record<Tab, string>;

export function NotebookTabs({
  runCount,
  view,
  update,
}: {
  runCount: number;
  view: NotebookView;
  update: UpdateView;
}) {
  return (
    <nav className="notebook-navigation" aria-label="Notebook views">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          aria-current={view.tab === tab ? "page" : undefined}
          onClick={() => update({ tab })}
        >
          {TAB_LABELS[tab]}
          {tab === "history" && runCount > 0 ? (
            <span className="tab-count">{count(runCount)}</span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}
