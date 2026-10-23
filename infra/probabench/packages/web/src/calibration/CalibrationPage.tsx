import { calibrationErrorText, type Run, summarizeRun } from "@probabench/domain";
import { useId, useMemo } from "react";
import { type NotebookView, toggleHidden, type UpdateView } from "../app/notebook-view";
import { count, date, modelName, samplingText, shortId, time, timestamp } from "../common/format";
import { Measurements } from "../common/Measurements";
import { type ModelStyle, styleOf } from "../common/palette";
import { modelSelections, withComparison } from "../common/run-history";
import { CalibrationChart } from "./CalibrationChart";
import "./calibration.css";

export function CalibrationPage({
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
  const descriptionId = useId();
  const selections = useMemo(
    () => modelSelections(runs, view.comparisons),
    [runs, view.comparisons],
  );
  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const chosen = useMemo(
    () => selections.filter(({ model }) => !hidden.has(model)).map(({ selected }) => selected),
    [selections, hidden],
  );
  const select = (id: string) => {
    const run = runs.find((item) => item.id === id);
    if (run) update({ comparisons: withComparison(view.comparisons, runs, run) });
  };
  return (
    <section>
      <h2 className="sr-only">Calibration</h2>
      <div className="chart-layout">
        <section className="card chart-card">
          <header className="chart-heading">
            <div>
              <h3>Target vs. observed</h3>
              <p>Fraction of valid replies that are 1</p>
            </div>
            <button
              type="button"
              className="interval-toggle"
              aria-pressed={view.intervals}
              onClick={() => update({ intervals: !view.intervals }, "replace")}
            >
              <span aria-hidden="true">↕</span> 95% intervals
            </button>
          </header>
          <CalibrationChart
            runs={chosen}
            styles={styles}
            intervals={view.intervals}
            descriptionId={descriptionId}
          />
          <div className="chart-caption">
            <span className="reference-key">
              <span aria-hidden="true" />
              Calibrated sampling (y = x)
            </span>
            <span className="mono">
              {chosen.length} / {selections.length} models
            </span>
          </div>
          <p id={descriptionId} className="chart-description">
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
                  { hidden: hidden.size > 0 ? [] : selections.map(({ model }) => model) },
                  "replace",
                )
              }
            >
              {hidden.size > 0 ? "Show all" : "Hide all"}
            </button>
          </div>
          <fieldset className="model-fieldset">
            <legend className="sr-only">Models shown in chart</legend>
            {selections.map(({ model, runs: history, selected }) => {
              const summary = summarizeRun(selected);
              const active = !hidden.has(model);
              const { color } = styleOf(styles, model);
              return (
                <div className="model-item" key={model}>
                  <button
                    type="button"
                    className="model-toggle"
                    aria-pressed={active}
                    onClick={() => update({ hidden: toggleHidden(view.hidden, model) }, "replace")}
                  >
                    <span className="model-check" style={{ color }}>
                      {active ? "✓" : ""}
                    </span>
                    <span className="model-label">
                      <strong>{modelName(model)}</strong>
                      <span className="model-replies">
                        {count(summary.valid)} / {count(summary.total)} valid replies
                      </span>
                    </span>
                  </button>
                  <label className="run-select">
                    <span className="sr-only">Run for {model}</span>
                    <select value={selected.id} onChange={(event) => select(event.target.value)}>
                      {history.map((item, index) => (
                        <option key={item.id} value={item.id}>
                          {index === 0 ? "Latest · " : ""}
                          {date(item.startedAt)} · {time(item.startedAt)} · {shortId(item.id)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </fieldset>
          <p className="panel-note">
            Color identifies a model. A saved run captures one set of settings and samples.
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
                <span
                  className="color-dot"
                  style={{ background: styleOf(styles, run.model).color }}
                />
                <strong>{modelName(run.model)}</strong>
                <span className="measurement-date">{timestamp(run.startedAt)}</span>
                <span className="measurement-error">
                  {calibrationErrorText(summarizeRun(run).meanCalibrationError)}
                  <small>mean error</small>
                </span>
                <span className="expand-sign" aria-hidden="true">
                  +
                </span>
              </summary>
              <Measurements run={run} />
              <div className="measurement-foot">{samplingText(run)}</div>
            </details>
          ))
        )}
      </section>
    </section>
  );
}
