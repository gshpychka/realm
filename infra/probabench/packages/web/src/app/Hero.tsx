import { type Run, summarizeRun } from "@probabench/domain";
import { count, date, time } from "../common/format";
import { newestFirst } from "../common/run-history";

/** The notebook's totals, once it has runs. */
function NotebookOverview({ runs }: { runs: readonly Run[] }) {
  const models = new Set(runs.map((run) => run.model));
  const valid = runs.reduce((sum, run) => sum + summarizeRun(run).valid, 0);
  const latest = newestFirst(runs)[0];
  return (
    <section className="notebook-overview" aria-label="Notebook totals">
      <dl>
        <div>
          <dt>Saved runs</dt>
          <dd>{count(runs.length)}</dd>
        </div>
        <div>
          <dt>Models observed</dt>
          <dd>{count(models.size)}</dd>
        </div>
        <div>
          <dt>Valid samples</dt>
          <dd>{count(valid)}</dd>
        </div>
      </dl>
      <p className="overview-date">
        {latest ? (
          <>
            Last observation
            <time dateTime={latest.startedAt}>
              {date(latest.startedAt)} <span>· {time(latest.startedAt)} UTC</span>
            </time>
          </>
        ) : null}
      </p>
    </section>
  );
}

/** An introduction while the notebook is empty; a title and its totals once it has runs. */
export function Hero({ runs }: { runs: readonly Run[] }) {
  if (runs.length === 0)
    return (
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Language models, under observation</p>
          <h1>
            Can a model <em>keep a probability?</em>
          </h1>
          <p>
            Ask for a 1 with probability <var>x</var>. Measure what comes back.
          </p>
        </div>
        <aside className="hero-note">
          <div className="hero-formula">
            <span>P(1)</span>
            <span className="formula-equals">=</span>
            <var>x</var>
          </div>
          <div className="hero-note-text">
            <span className="eyebrow">The promise</span>
            <p>A calibrated sampler produces ones as often as it was asked to.</p>
            <span className="hero-note-link">A 30% target. About 30% ones.</span>
          </div>
        </aside>
      </section>
    );
  return (
    <>
      <header className="masthead">
        <h1>A sampling notebook.</h1>
        <p>How closely do language models follow a probability?</p>
      </header>
      <NotebookOverview runs={runs} />
    </>
  );
}
