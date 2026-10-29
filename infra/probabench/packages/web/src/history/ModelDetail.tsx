import { calibrationErrorText, type ModelEvidence } from "@probabench/domain";
import { date, modelName } from "../common/format";

export function ModelDetail({
  evidence,
  through,
  onCompare,
}: {
  evidence: ModelEvidence;
  through: string | null;
  onCompare: () => void;
}) {
  return (
    <section className="card model-detail" aria-label={`Results for ${evidence.model}`}>
      <h3>{modelName(evidence.modelSlug)}</h3>
      <p className="model-slug">Reasoning: {evidence.reasoning}</p>
      {through ? <p className="model-slug">Through {date(through)}</p> : null}
      <dl className="detail-list">
        <div>
          <dt>Mean absolute error</dt>
          <dd>{calibrationErrorText(evidence.summary.meanCalibrationError)}</dd>
        </div>
      </dl>
      <button type="button" className="button secondary full-width" onClick={onCompare}>
        View results <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}
