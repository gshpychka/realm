import { type Run, summarizeRun } from "@probabench/domain";
import { lazy, useMemo, useRef } from "react";
import type { NotebookView, useNotebookView } from "../app/notebook-view";
import { ChartBoundary } from "../common/chart-frame";
import { count, date, gap, modelName, percent, samplingText, time } from "../common/format";
import { type ModelStyle, styleOf } from "../common/palette";
import { visibleHistory } from "../common/run-history";
import { Measurements, RunDetail } from "./RunDetail";

type UpdateView = ReturnType<typeof useNotebookView>[1];
const HistoryChart = lazy(() =>
  import("./HistoryChart").then((module) => ({ default: module.HistoryChart })),
);

export function HistoryPage({
  runs,
  styles,
  view,
  update,
  onCompare,
  onRerun,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
  view: NotebookView;
  update: UpdateView;
  onCompare: (run: Run) => void;
  onRerun: (run: Run) => void;
}) {
  const inspector = useRef<HTMLElement>(null);
  const inspect = (run: Run) => {
    update({ runId: run.id });
    if (window.matchMedia("(max-width: 900px)").matches) {
      inspector.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
    }
  };
  const visible = useMemo(
    () => visibleHistory(runs, view.query, view.hidden),
    [runs, view.query, view.hidden],
  );
  const inspected = visible.find((run) => run.id === view.runId) ?? visible[0];
  const days = new Map<string, Run[]>();
  for (const run of visible) {
    const key = run.startedAt.slice(0, 10);
    const group = days.get(key) ?? [];
    group.push(run);
    days.set(key, group);
  }
  return (
    <section className="history-page">
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
          <button
            type="button"
            className="text-button"
            onClick={() => update({ query: "", hidden: [] }, "replace")}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <section className="chart-card history-graph-card" aria-label="Benchmark history graph">
        <header className="chart-heading">
          <div>
            <h3>Calibration, over time</h3>
            <p>Mean calibration gap · lower means closer to the requested probabilities</p>
          </div>
          <span className="tag">UTC timeline</span>
        </header>
        <fieldset className="history-graph-legend">
          <legend className="sr-only">Models shown in history</legend>
          {[...new Set(runs.map((run) => run.model))].map((model) => (
            <button
              key={model}
              type="button"
              aria-pressed={!view.hidden.includes(model)}
              onClick={() =>
                update(
                  {
                    hidden: view.hidden.includes(model)
                      ? view.hidden.filter((item) => item !== model)
                      : [...view.hidden, model],
                  },
                  "replace",
                )
              }
            >
              <span className="color-dot" style={{ background: styleOf(styles, model).color }} />
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
        <p role="status" className="panel-note linked-run-missing">
          The linked run is not in this notebook. Showing the latest matching run.
        </p>
      ) : null}
      <div className="history-layout">
        {inspected ? (
          <aside className="history-inspector" ref={inspector}>
            <RunDetail
              run={inspected}
              onCompare={() => onCompare(inspected)}
              onRerun={() => onRerun(inspected)}
            />
            <details className="inspector-measurements">
              <summary>
                Inspect measurements <span aria-hidden="true">+</span>
              </summary>
              <Measurements run={inspected} />
            </details>
          </aside>
        ) : null}
        <div className="timeline-panel">
          {visible.length === 0 ? (
            <div className="search-empty">
              <h3>No matching runs.</h3>
              <p>Show more models or clear the search to see their history.</p>
              <button
                type="button"
                className="text-button"
                onClick={() => update({ query: "", hidden: [] }, "replace")}
              >
                Clear filters
              </button>
            </div>
          ) : (
            [...days].map(([day, items]) => (
              <section key={day} className="timeline-day">
                <h3>
                  {date(items[0]?.startedAt ?? day)}
                  <span>UTC</span>
                </h3>
                <ol>
                  {items.map((run) => {
                    const summary = summarizeRun(run);
                    return (
                      <li key={run.id}>
                        <button
                          type="button"
                          className={`history-row ${inspected?.id === run.id ? "selected" : ""}`}
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
                            <strong>{gap(summary.meanCalibrationError)}</strong>
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
