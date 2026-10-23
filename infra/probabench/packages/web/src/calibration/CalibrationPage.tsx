import { type Results, type Run, summarizeRun } from "@probabench/domain";
import { lazy, Suspense, useMemo } from "react";
import type { NotebookView, useNotebookView } from "../app/notebook-view";
import { date, modelName, number, time } from "../common/format";
import { LoadBoundary } from "../common/LoadBoundary";
import { groupHistory, selectedRuns } from "../common/run-history";
import { gap, Measurements } from "../history/RunDetail";
import { modelColors } from "./calibration-chart-data";

type UpdateView = ReturnType<typeof useNotebookView>[1];
const CalibrationChart = lazy(() =>
  import("./CalibrationChart").then((module) => ({ default: module.CalibrationChart })),
);
const History = lazy(() =>
  import("../history/HistoryPage").then((module) => ({ default: module.HistoryPage })),
);

export function CalibrationPage({
  results,
  view,
  update,
  onRerun,
}: {
  results: Results;
  view: NotebookView;
  update: UpdateView;
  onRerun: (run: Run) => void;
}) {
  const groups = useMemo(() => groupHistory(results.runs), [results]);
  const colors = useMemo(() => modelColors(results.runs), [results]);
  const selections = useMemo(
    () =>
      new Map(
        results.runs
          .filter((run) => view.comparisons.includes(run.id))
          .map((run) => [run.model, run.id]),
      ),
    [results, view.comparisons],
  );
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const chosen = useMemo(
    () => selectedRuns(groups, selections, hidden),
    [groups, selections, hidden],
  );
  const toggle = (model: string) =>
    update(
      {
        hidden: hidden.has(model)
          ? view.hidden.filter((item) => item !== model)
          : [...view.hidden, model],
      },
      "replace",
    );
  const comparisonsWith = (run: Run) => [
    ...view.comparisons.filter(
      (id) => !results.runs.some((item) => item.id === id && item.model === run.model),
    ),
    run.id,
  ];
  const select = (id: string) => {
    const run = results.runs.find((item) => item.id === id);
    if (run) update({ comparisons: comparisonsWith(run) });
  };
  const compare = (run: Run) => {
    update({
      tab: "calibration",
      comparisons: comparisonsWith(run),
      hidden: view.hidden.filter((model) => model !== run.model),
    });
    document.getElementById("tab-calibration")?.focus();
  };
  if (view.tab === "history")
    return (
      <LoadBoundary surface="notebook">
        <Suspense
          fallback={
            <div className="chart-loading" role="status">
              <span className="loading-line" />
              Loading the run history…
            </div>
          }
        >
          <History
            runs={results.runs}
            colors={colors}
            view={view}
            update={update}
            onCompare={compare}
            onRerun={onRerun}
          />
        </Suspense>
      </LoadBoundary>
    );
  return (
    <section className="calibration-page">
      <h2 className="sr-only">Calibration</h2>
      <div className="chart-layout">
        <section className="chart-card">
          <header className="chart-heading">
            <div>
              <h3>Target vs. observed</h3>
              <p>Fraction of valid replies that are 1</p>
            </div>
            <button
              type="button"
              className={`interval-toggle ${view.intervals ? "selected" : ""}`}
              aria-pressed={view.intervals}
              onClick={() => update({ intervals: !view.intervals }, "replace")}
            >
              <span aria-hidden="true">↕</span> 95% intervals
            </button>
          </header>
          <LoadBoundary>
            <Suspense
              fallback={
                <div className="chart-loading" role="status">
                  <span className="loading-line" />
                  Loading the observations…
                </div>
              }
            >
              <CalibrationChart runs={chosen} colors={colors} intervals={view.intervals} />
            </Suspense>
          </LoadBoundary>
          <div className="chart-caption">
            <span className="reference-key">
              <span aria-hidden="true" />
              Calibrated sampling · y = x
            </span>
            <span className="mono">
              {chosen.length} / {groups.length} models
            </span>
          </div>
          <p id="chart-description" className="chart-description">
            Points mark measured targets; lines join them. Gaps mark targets with no valid replies.
            Intervals assume independent valid responses.
          </p>
        </section>
        <aside className="model-panel">
          <div className="panel-heading">
            <h3>Models</h3>
            <button
              type="button"
              className="text-button tiny"
              onClick={() =>
                update(
                  { hidden: hidden.size > 0 ? [] : groups.map((group) => group.model) },
                  "replace",
                )
              }
            >
              {hidden.size > 0 ? "Show all" : "Hide all"}
            </button>
          </div>
          <fieldset className="model-fieldset">
            <legend className="sr-only">Models shown in chart</legend>
            {groups.map((group) => {
              const run =
                group.runs.find((item) => item.id === selections.get(group.model)) ?? group.runs[0];
              if (!run) return null;
              const summary = summarizeRun(run);
              const active = !hidden.has(group.model);
              return (
                <div className={`model-item ${active ? "active" : ""}`} key={group.model}>
                  <button
                    type="button"
                    className="model-toggle"
                    aria-pressed={active}
                    onClick={() => toggle(group.model)}
                  >
                    <span
                      className="model-check"
                      style={{
                        color: colors.get(group.model),
                        borderColor: active ? colors.get(group.model) : undefined,
                      }}
                    >
                      {active ? "✓" : ""}
                    </span>
                    <span>
                      <strong>{modelName(group.model)}</strong>
                      <span>
                        {number(summary.valid)} / {number(summary.total)} valid replies
                      </span>
                    </span>
                  </button>
                  <label className="run-select">
                    <span className="sr-only">Run for {group.model}</span>
                    <select value={run.id} onChange={(event) => select(event.target.value)}>
                      {group.runs.map((item, index) => (
                        <option key={item.id} value={item.id}>
                          {index === 0 ? "Latest · " : ""}
                          {date(item.startedAt)} · {time(item.startedAt)} · {item.id.slice(-6)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </fieldset>
          <p className="panel-note">
            Colour identifies a model. A saved run captures one set of settings and samples.
          </p>
        </aside>
      </div>
      <section className="measurements-panel">
        <header>
          <div>
            <h3>Measurements</h3>
          </div>
          <span className="tag">
            {chosen.length} selected {chosen.length === 1 ? "run" : "runs"}
          </span>
        </header>
        {chosen.length === 0 ? (
          <p className="muted measurement-empty">Select a model to see its measurements.</p>
        ) : (
          chosen.map((run) => (
            <details className="measurement-run" key={run.id}>
              <summary>
                <span className="color-dot" style={{ background: colors.get(run.model) }} />
                <strong>{modelName(run.model)}</strong>
                <span className="measurement-date">
                  {date(run.startedAt)} · {time(run.startedAt)} UTC
                </span>
                <span className="measurement-gap">
                  {gap(summarizeRun(run).meanCalibrationError)}
                  <small>mean gap</small>
                </span>
                <span className="expand-sign" aria-hidden="true">
                  +
                </span>
              </summary>
              <Measurements run={run} />
              <div className="measurement-foot">
                {run.trialsPerStep} samples per target · {run.stepPercent}% target step
              </div>
            </details>
          ))
        )}
      </section>
    </section>
  );
}
