import { calibrationErrorText, type Run, summarizeRun } from "@probabench/domain";
import { useMemo, useRef } from "react";
import { count, date, modelName, percent, samplingText, time } from "../common/format";
import { Measurements } from "../common/Measurements";
import {
  type NotebookView,
  PANEL_ID,
  toggleHidden,
  type UpdateView,
} from "../common/notebook-view";
import { type ModelStyle, styleOf } from "../common/palette";
import { inspectedRun, runsByDay, visibleHistory, withComparison } from "../common/run-history";
import { HistoryChart } from "./HistoryChart";
import { RunDetail } from "./RunDetail";
import "./history.css";

// history.css stacks the inspector above the timeline at this width; keep the two in sync.
const STACKED_LAYOUT = "(max-width: 900px)";

export function HistoryPage({
  runs,
  styles,
  view,
  update,
}: {
  runs: readonly Run[];
  styles: ReadonlyMap<string, ModelStyle>;
  view: NotebookView;
  update: UpdateView;
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
    document.getElementById(PANEL_ID)?.focus();
  };
  // A link can hide a model this notebook lacks, which filters nothing.
  const filtered = view.hidden.some((model) => styles.has(model));
  const visible = useMemo(() => visibleHistory(runs, view.hidden), [runs, view.hidden]);
  const inspected = inspectedRun(visible, view.runId);
  return (
    <section>
      <h2 className="sr-only">Run history</h2>
      <div className="history-toolbar">
        <span className="mono muted">
          {count(visible.length)} / {count(runs.length)} runs
        </span>
        {filtered ? (
          <button
            type="button"
            className="text-button"
            onClick={() => update({ hidden: [] }, "replace")}
          >
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
        <HistoryChart runs={visible} styles={styles} />
      </section>
      <div className="history-layout">
        {inspected ? (
          <aside className="history-inspector" ref={inspector}>
            <RunDetail run={inspected} onCompare={() => compare(inspected)} />
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
        {visible.length > 0 ? (
          <div className="card">
            {runsByDay(visible).map(([day, items]) => (
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
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
