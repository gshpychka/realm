import {
  calibrationErrorText,
  type EvidenceCheckpoint,
  type ModelEvidence,
} from "@probabench/domain";
import { useRef } from "react";
import { modelName } from "../common/format";
import { Measurements } from "../common/Measurements";
import { type ModelStyle, styleOf } from "../common/palette";
import { PANEL_ID, type ResultsView, toggleHidden, type UpdateView } from "../common/results-view";
import { HistoryChart } from "./HistoryChart";
import { ModelDetail } from "./ModelDetail";
import "./history.css";

export function HistoryPage({
  evidence,
  history,
  styles,
  view,
  update,
}: {
  evidence: readonly ModelEvidence[];
  history: readonly EvidenceCheckpoint[];
  styles: ReadonlyMap<string, ModelStyle>;
  view: ResultsView;
  update: UpdateView;
}) {
  const inspector = useRef<HTMLElement>(null);
  const visible = evidence.filter(({ model }) => !view.hidden.includes(model));
  const inspected = visible.find(({ model }) => model === view.model) ?? visible[0];
  const inspect = (model: string, through = view.through) => {
    update({ model, through });
    if (window.matchMedia("(max-width: 900px)").matches)
      inspector.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  };
  return (
    <section className="history-page">
      <section className="card chart-card" aria-label="Mean absolute error over time">
        <header className="chart-heading">
          <div>
            <h2>Mean absolute error over time</h2>
            <p>Percentage points · Lower is better</p>
          </div>
          {view.through ? (
            <button
              type="button"
              className="text-button tiny"
              onClick={() => update({ through: null })}
            >
              Show latest
            </button>
          ) : null}
        </header>
        <details className="history-model-filters">
          <summary>
            <span>Filter models</span>
          </summary>
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
        </details>
        <HistoryChart
          history={history.filter(({ model }) => !view.hidden.includes(model))}
          styles={styles}
          through={view.through}
          onInspect={(point) => inspect(point.model, point.day)}
        />
      </section>
      {view.hidden.length > 0 ? (
        <div className="history-toolbar">
          <button
            type="button"
            className="text-button"
            onClick={() => update({ hidden: [] }, "replace")}
          >
            Show all models
          </button>
        </div>
      ) : null}
      <div className="history-layout">
        {inspected ? (
          <aside className="history-inspector" ref={inspector}>
            <ModelDetail
              evidence={inspected}
              through={view.through}
              onCompare={() => {
                update({ tab: "calibration", model: inspected.model, through: null });
                document.getElementById(PANEL_ID)?.focus();
              }}
            />
            <details className="card inspector-measurements">
              <summary>
                Measurements{" "}
                <span className="expand-sign" aria-hidden="true">
                  +
                </span>
              </summary>
              <Measurements evidence={inspected} />
            </details>
          </aside>
        ) : null}
        <div className="card evidence-list">
          {visible.length === 0 ? (
            <p className="muted evidence-list-empty">Select a model to see its measurements.</p>
          ) : (
            <ul>
              {visible.map((item) => (
                <li key={item.model}>
                  <button
                    type="button"
                    className="history-row"
                    aria-pressed={item.model === inspected?.model}
                    onClick={() => inspect(item.model)}
                  >
                    <span
                      className="color-dot"
                      style={{ background: styleOf(styles, item.model).color }}
                    />
                    <span className="history-row-main">
                      <strong>{modelName(item.model)}</strong>
                    </span>
                    <span className="history-row-metric">
                      <strong>{calibrationErrorText(item.summary.meanCalibrationError)}</strong>
                    </span>
                    <span className="row-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
