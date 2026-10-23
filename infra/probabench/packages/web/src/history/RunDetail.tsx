import { calibrationErrorText, type Run, summarizeRun } from "@probabench/domain";
import { count, date, modelName, percent, time } from "../common/format";

export function RunDetail({ run, onCompare }: { run: Run; onCompare: () => void }) {
  const summary = summarizeRun(run);
  return (
    <section className="card run-detail" aria-label={`Run details for ${run.model}`}>
      <p className="eyebrow">Inspected run</p>
      <h3>{modelName(run.model)}</h3>
      <p className="model-slug">{run.modelSlug}</p>
      <div className="detail-timestamp">
        <time dateTime={run.startedAt}>
          {date(run.startedAt)}
          <span>{time(run.startedAt)} UTC</span>
        </time>
        <span className="tag">reasoning {run.reasoning}</span>
      </div>
      <div className="detail-stats">
        <div>
          <span>Mean calibration error</span>
          <strong>{calibrationErrorText(summary.meanCalibrationError)}</strong>
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
            {count(summary.valid)} valid / {count(summary.total)}
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
          <dd>{count(run.trialsPerStep)}</dd>
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
      <button type="button" className="button secondary full-width" onClick={onCompare}>
        View on calibration chart <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
