import type { KeyboardEvent } from "react";
import { count } from "../common/format";
import {
  type NotebookView,
  PANEL_ID,
  TABS,
  type Tab,
  tabId,
  type UpdateView,
} from "./notebook-view";

const TAB_LABELS = {
  calibration: "Calibration",
  history: "Run history",
  method: "Method",
} as const satisfies Record<Tab, string>;

/** Roving focus: the arrows move to the neighbouring tab, Home and End to either end. */
const KEY_TARGET: Readonly<Record<string, (index: number, length: number) => number>> = {
  ArrowRight: (index, length) => (index + 1) % length,
  ArrowLeft: (index, length) => (index + length - 1) % length,
  Home: () => 0,
  End: (_, length) => length - 1,
};

export function NotebookTabs({
  runCount,
  view,
  update,
}: {
  runCount: number;
  view: NotebookView;
  update: UpdateView;
}) {
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = KEY_TARGET[event.key];
    const tab = target && TABS[target(index, TABS.length)];
    if (!tab) return;
    event.preventDefault();
    update({ tab });
    document.getElementById(tabId(tab))?.focus();
  };
  return (
    <div className="notebook-navigation">
      <div role="tablist" aria-label="Notebook views">
        {TABS.map((tab, index) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={tabId(tab)}
            aria-selected={view.tab === tab}
            aria-controls={PANEL_ID}
            tabIndex={view.tab === tab ? 0 : -1}
            onKeyDown={(event) => moveFocus(event, index)}
            onClick={() => update({ tab })}
          >
            {TAB_LABELS[tab]}
            {tab === "history" && runCount > 0 ? (
              <span className="tab-count">{count(runCount)}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
