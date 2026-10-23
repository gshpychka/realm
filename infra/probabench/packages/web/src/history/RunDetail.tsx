import { type Run, summarizeRun } from "@probabench/domain";
import type { BenchRequest } from "../bridge/protocol";
import { count, date, gap, modelName, percent, time } from "../common/format";
import { rerunRequest } from "../setup/run-settings";

export function RunDetail({
  run,
  onCompare,
  onRerun,
}: {
  run: Run;
  onCompare: () => void;
  onRerun: (request: BenchRequest) => void;
}) {
  const summary = summarizeRun(run);
  // Null for a run the setup form cannot express, which then offers no rerun.
  const rerun = rerunRequest(run);
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
      {rerun ? (
        <div className="run-actions">
          <button type="button" className="text-button" onClick={() => onRerun(rerun)}>
            Run again <span aria-hidden="true">↗</span>
          </button>
        </div>
      ) : null}
      <p className="detail-note">
        Mean gap averages the absolute difference between target and observed frequency across
        targets with valid replies. Compare like-for-like grids and budgets.
      </p>
    </section>
  );
}
