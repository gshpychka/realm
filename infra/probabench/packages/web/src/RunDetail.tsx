import {
  measurePoint,
  ResultsJson,
  type Run,
  SCHEMA_VERSION,
  summarizeRun,
} from "@probabench/domain";
import * as Schema from "effect/Schema";
import { validateBenchmarkOptions } from "./benchmark";
import { date, modelName, number, percent, time } from "./format";

export const gap = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(1)} pp`;

export function Measurements({ run }: { run: Run }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll wide measurement tables.
    <section className="table-scroll" tabIndex={0} aria-label={`Measurements for ${run.model}`}>
      <table className="measurement-table">
        <caption className="sr-only">
          Measured sampling frequencies for {run.model}, {date(run.startedAt)} {time(run.startedAt)}{" "}
          UTC
        </caption>
        <thead>
          <tr>
            {["Target", "Observed", "95% interval", "Ones / valid", "Invalid"].map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.points.map((point) => {
            const { observed, interval, ones, valid, invalid, total } = measurePoint(point);
            return (
              <tr key={point.x}>
                <th scope="row">{percent(point.x, 0)}</th>
                <td className="table-observed">
                  {observed === null ? "No valid replies" : percent(observed)}
                </td>
                <td>{interval ? `${percent(interval[0], 0)}–${percent(interval[1], 0)}` : "—"}</td>
                <td>
                  {number(ones)} / {number(valid)}
                </td>
                <td>
                  {number(invalid)} / {number(total)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function downloadRun(run: Run) {
  const contents = `${Schema.encodeSync(ResultsJson)({ schemaVersion: SCHEMA_VERSION, runs: [run] })}\n`;
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `probabench-${run.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100)}.json`;
  link.click();
  // Keep the object URL alive until the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RunDetail({
  run,
  onCompare,
  onRerun,
}: {
  run: Run;
  onCompare?: () => void;
  onRerun?: () => void;
}) {
  const summary = summarizeRun(run);
  const canRerun =
    validateBenchmarkOptions({
      model: run.modelSlug,
      trialsPerStep: run.trialsPerStep,
      stepPercent: run.stepPercent,
      concurrency: 5,
    }) === null;
  return (
    <section className="run-detail" aria-label={`Run details for ${run.model}`}>
      <p className="eyebrow">Selected observation</p>
      <h3>{modelName(run.model)}</h3>
      <p className="model-slug">{run.modelSlug}</p>
      <div className="detail-timestamp">
        <time dateTime={run.startedAt}>
          {date(run.startedAt)}
          <span>{time(run.startedAt)} UTC</span>
        </time>
        <span className="tag">{run.reasoning} reasoning</span>
      </div>
      <div className="detail-stats">
        <div>
          <span>Mean calibration gap</span>
          <strong>{gap(summary.meanCalibrationError)}</strong>
        </div>
        <div>
          <span>Valid replies</span>
          <strong>{percent(summary.validity)}</strong>
        </div>
      </div>
      <dl className="detail-list">
        <div>
          <dt>Samples</dt>
          <dd>
            {number(summary.valid)} valid / {number(summary.total)}
          </dd>
        </div>
        <div>
          <dt>Measured targets</dt>
          <dd>
            {summary.coveredPoints} / {summary.totalPoints}
          </dd>
        </div>
        <div>
          <dt>Samples per target</dt>
          <dd>{number(run.trialsPerStep)}</dd>
        </div>
        <div>
          <dt>Target step</dt>
          <dd>{run.stepPercent}%</dd>
        </div>
        <div>
          <dt>Run ID</dt>
          <dd className="run-id" title={run.id}>
            {run.id}
          </dd>
        </div>
      </dl>
      {onCompare ? (
        <button type="button" className="button secondary full-width" onClick={onCompare}>
          View on calibration chart <span aria-hidden="true">↗</span>
        </button>
      ) : null}
      <div className="run-actions">
        {onRerun && canRerun ? (
          <button type="button" className="text-button" onClick={onRerun}>
            Run again <span aria-hidden="true">↗</span>
          </button>
        ) : null}
        <button type="button" className="text-button" onClick={() => downloadRun(run)}>
          Download JSON <span aria-hidden="true">↓</span>
        </button>
      </div>
      <p className="detail-note">
        Mean gap averages the absolute difference between target and observed frequency across
        targets with valid replies. Compare like-for-like grids and budgets.
      </p>
    </section>
  );
}
