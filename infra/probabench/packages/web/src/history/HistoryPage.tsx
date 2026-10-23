import { calibrationErrorText, type Run, summarizeRun } from "@probabench/domain";
import { lazy, useMemo, useRef } from "react";
import { type NotebookView, tabId, toggleHidden, type UpdateView } from "../app/notebook-view";
import type { BenchRequest } from "../bridge/protocol";
import { ChartBoundary } from "../common/chart-frame";
import { count, date, modelName, percent, samplingText, time } from "../common/format";
import { Measurements } from "../common/Measurements";
import { type ModelStyle, styleOf } from "../common/palette";
import { inspectedRun, runsByDay, visibleHistory, withComparison } from "../common/run-history";
import { RunDetail } from "./RunDetail";
import "./history.css";

// history.css stacks the inspector above the timeline at this width; keep the two in sync.
const STACKED_LAYOUT = "(max-width: 900px)";

const HistoryChart = lazy(() =>
  import("./HistoryChart").then((module) => ({ default: module.HistoryChart })),
);

export function HistoryPage({
  runs,
  styles,
  view,
  update,
  onRerun,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
  view: NotebookView;
  update: UpdateView;
  onRerun: (request: BenchRequest) => void;
}) {
  const inspector = useRef<HTMLElement>(null);
  const inspect = (run: Run) => {
    update({ runId: run.id });
    if (window.matchMedia(STACKED_LAYOUT).matches) inspector.current?.scrollIntoView();
  };
  const compare = (run: Run) => {
    update({
      tab: "calibration",
      comparisons: withComparison(view.comparisons, runs, run),
      hidden: view.hidden.filter((model) => model !== run.model),
    });
    document.getElementById(tabId("calibration"))?.focus();
  };
  const clearFilters = () => update({ query: "", hidden: [] }, "replace");
  const visible = useMemo(
    () => visibleHistory(runs, view.query, view.hidden),
    [runs, view.query, view.hidden],
  );
  const inspected = inspectedRun(visible, view.runId);
  return (
    <section>
      <h2 className="sr-only">Run history</h2>
      <div className="history-toolbar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            aria-label="Search run history"
            placeholder="Find a model or run…"
            value={view.query}
            onChange={(event) => update({ query: event.target.value }, "replace")}
          />
        </label>
        <span className="mono muted">
          {count(visible.length)} / {count(runs.length)} runs
        </span>
        {view.query || view.hidden.length > 0 ? (
          <button type="button" className="text-button" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>
      <section className="card chart-card history-graph-card" aria-label="Benchmark history graph">
        <header className="chart-heading">
          <div>
            <h3>Calibration, over time</h3>
            <p>Mean calibration error · lower means closer to the requested probabilities</p>
          </div>
          <span className="tag">UTC timeline</span>
        </header>
        <fieldset className="history-graph-legend">
          <legend className="sr-only">Models shown in history</legend>
          {[...styles].map(([model, style]) => (
            <button
              key={model}
              type="button"
              aria-pressed={!view.hidden.includes(model)}
              onClick={() => update({ hidden: toggleHidden(view.hidden, model) }, "replace")}
            >
              <span className="color-dot" style={{ background: style.color }} />
              {modelName(model)}
            </button>
          ))}
        </fieldset>
        <ChartBoundary>
          <HistoryChart
            runs={visible}
            styles={styles}
            selectedId={inspected?.id}
            onSelect={inspect}
          />
        </ChartBoundary>
      </section>
      {view.runId && !runs.some((run) => run.id === view.runId) ? (
        <p role="status" className="panel-note">
          The linked run is not in this notebook. Showing the latest matching run.
        </p>
      ) : null}
      <div className="history-layout">
        {inspected ? (
          <aside className="history-inspector" ref={inspector}>
            <RunDetail run={inspected} onCompare={() => compare(inspected)} onRerun={onRerun} />
            <details className="card inspector-measurements">
              <summary>
                Inspect measurements{" "}
                <span className="expand-sign" aria-hidden="true">
                  +
                </span>
              </summary>
              <Measurements run={inspected} />
            </details>
          </aside>
        ) : null}
        <div className="card">
          {visible.length === 0 ? (
            <div className="search-empty">
              <h3>No matching runs.</h3>
              <p>Show more models or clear the search to see their history.</p>
              <button type="button" className="text-button" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            runsByDay(visible).map(([day, items]) => (
              <section key={day} className="timeline-day">
                <h3>
                  {date(day)}
                  <span>UTC</span>
                </h3>
                <ol>
                  {items.map((run) => {
                    const summary = summarizeRun(run);
                    return (
                      <li key={run.id}>
                        <button
                          type="button"
                          className="history-row"
                          aria-pressed={inspected?.id === run.id}
                          onClick={() => inspect(run)}
                        >
                          <span
                            className="timeline-node"
                            style={{ background: styleOf(styles, run.model).color }}
                          />
                          <span className="history-row-main">
                            <strong>{modelName(run.model)}</strong>
                            <span>
                              {time(run.startedAt)} · {samplingText(run)}
                            </span>
                          </span>
                          <span className="history-row-metric">
                            <strong>{calibrationErrorText(summary.meanCalibrationError)}</strong>
                            <span>{percent(summary.validity, 0)} valid</span>
                          </span>
                          <span className="row-arrow" aria-hidden="true">
                            ↗
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
