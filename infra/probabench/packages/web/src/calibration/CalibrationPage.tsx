import { calibrationErrorText, type ModelEvidence } from "@probabench/domain";
import { modelName } from "../common/format";
import { Measurements } from "../common/Measurements";
import { type ModelStyle, styleOf } from "../common/palette";
import { type ResultsView, toggleHidden, type UpdateView } from "../common/results-view";
import { CalibrationChart } from "./CalibrationChart";
import "./calibration.css";

export function CalibrationPage({
  evidence,
  styles,
  view,
  update,
}: {
  evidence: readonly ModelEvidence[];
  styles: ReadonlyMap<string, ModelStyle>;
  view: ResultsView;
  update: UpdateView;
}) {
  const hidden = new Set(view.hidden);
  const shown = evidence.filter(({ model }) => !hidden.has(model));
  const anyHidden = evidence.some(({ model }) => hidden.has(model));
  const ranked = evidence.toSorted(
    (a, b) =>
      (a.summary.meanCalibrationError ?? Infinity) - (b.summary.meanCalibrationError ?? Infinity),
  );
  return (
    <section>
      <div className="calibration-layout">
        <section className="card chart-card">
          <header className="chart-heading">
            <div>
              <h2>Sampling accuracy</h2>
              <p>Closer to the diagonal is better</p>
            </div>
            <button
              type="button"
              className="interval-toggle"
              aria-label="95% confidence intervals"
              aria-pressed={view.intervals}
              onClick={() => update({ intervals: !view.intervals }, "replace")}
            >
              95% CI
            </button>
          </header>
          <CalibrationChart evidence={shown} styles={styles} intervals={view.intervals} />
        </section>
        <aside className="model-panel">
          <div className="model-panel-heading">
            <h3>Models</h3>
            <button
              type="button"
              className="text-button tiny"
              onClick={() =>
                update({ hidden: anyHidden ? [] : evidence.map(({ model }) => model) }, "replace")
              }
            >
              {anyHidden ? "Show all" : "Hide all"}
            </button>
          </div>
          <p className="model-metric-label">Mean absolute error (pp) · Lower is better</p>
          <fieldset className="model-fieldset">
            <legend className="sr-only">Models shown in chart</legend>
            {ranked.map((item) => (
              <div className="model-item" key={item.model}>
                <button
                  type="button"
                  className="model-toggle"
                  aria-pressed={!hidden.has(item.model)}
                  onClick={() =>
                    update({ hidden: toggleHidden(view.hidden, item.model) }, "replace")
                  }
                >
                  <span
                    className="model-check"
                    style={{ color: styleOf(styles, item.model).color }}
                    aria-hidden="true"
                  >
                    {hidden.has(item.model) ? "" : "✓"}
                  </span>
                  <span className="model-label">
                    <strong>{modelName(item.model)}</strong>
                  </span>
                  <span className="model-score">
                    {calibrationErrorText(item.summary.meanCalibrationError)}
                  </span>
                </button>
              </div>
            ))}
          </fieldset>
        </aside>
      </div>
      <section className="measurements-panel">
        <header>
          <h2>Measurements</h2>
        </header>
        {shown.length === 0 ? (
          <p className="muted measurement-empty">Select a model to see its measurements.</p>
        ) : (
          shown.map((item) => (
            <details className="measurement-model" key={item.model}>
              <summary>
                <span
                  className="color-dot"
                  style={{ background: styleOf(styles, item.model).color }}
                />
                <strong>{modelName(item.model)}</strong>
                <span className="measurement-error">
                  {calibrationErrorText(item.summary.meanCalibrationError)}
                  <small>MAE</small>
                </span>
                <span className="expand-sign" aria-hidden="true">
                  +
                </span>
              </summary>
              <Measurements evidence={item} />
            </details>
          ))
        )}
      </section>
    </section>
  );
}
