import { type Run, summarizeRun } from "@probabench/domain";
import { count, date, time } from "../common/format";
import { newestFirst } from "../common/run-history";

function NotebookOverview({ runs, latest }: { runs: readonly Run[]; latest: Run }) {
  const models = new Set(runs.map((run) => run.model));
  const valid = runs.reduce((sum, run) => sum + summarizeRun(run).valid, 0);
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
        Last run
        <time dateTime={latest.startedAt}>
          {date(latest.startedAt)} <span>· {time(latest.startedAt)} UTC</span>
        </time>
      </p>
    </section>
  );
}

/** The notebook's title, and its totals once it has runs. */
export function Masthead({ runs }: { runs: readonly Run[] }) {
  const [latest] = newestFirst(runs);
  return (
    <>
      <header className="masthead">
        <h1>A sampling notebook.</h1>
        <p>How closely do language models follow a probability?</p>
      </header>
      {latest ? <NotebookOverview runs={runs} latest={latest} /> : null}
    </>
  );
}
