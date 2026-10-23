import type { Run } from "@probabench/domain";
import type { KeyboardEvent } from "react";
import { type CopyStatus, useClipboard } from "../common/clipboard";
import { count } from "../common/format";
import {
  type NotebookView,
  PANEL_ID,
  pinnedView,
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

const LINK_MESSAGE = {
  copied: "View link copied",
  failed: "Copy this page’s address from your browser to share the view.",
} as const satisfies Record<CopyStatus, string>;

export function NotebookTabs({
  runs,
  view,
  update,
}: {
  runs: readonly Run[];
  view: NotebookView;
  update: UpdateView;
}) {
  const { copy, statusOf } = useClipboard();
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = KEY_TARGET[event.key];
    const tab = target && TABS[target(index, TABS.length)];
    if (!tab) return;
    event.preventDefault();
    update({ tab });
    document.getElementById(tabId(tab))?.focus();
  };
  const copyLink = () => {
    update(pinnedView(runs, view), "replace");
    void copy(window.location.href);
  };
  const linkStatus = statusOf(window.location.href);
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
            {tab === "history" && runs.length > 0 ? (
              <span className="tab-count">{count(runs.length)}</span>
            ) : null}
          </button>
        ))}
      </div>
      {runs.length > 0 ? (
        <div className="view-actions">
          <button
            type="button"
            className="text-button share-view"
            aria-label="Copy view link"
            onClick={copyLink}
          >
            <span className="share-label">Copy view link</span>
            <svg
              className="copy-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
          <span role="status" className="copy-status">
            {linkStatus ? LINK_MESSAGE[linkStatus] : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}
