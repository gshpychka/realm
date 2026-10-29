import { Result, useAtomRefresh, useAtomValue } from "@effect-atom/atom-react";
import { collectEvidence, evidenceHistory, type Run } from "@probabench/domain";
import * as Option from "effect/Option";
import { useEffect, useMemo, useState } from "react";
import { useBridge } from "../bridge/use-bridge";
import { CalibrationPage } from "../calibration/CalibrationPage";
import { modelStyles } from "../common/palette";
import { PANEL_ID, useResultsView } from "../common/results-view";
import { HistoryPage } from "../history/HistoryPage";
import { MethodPage } from "../method/MethodPage";
import { RunSetup } from "../setup/RunSetup";
import { EmptyResults } from "./EmptyResults";
import { ResultsTabs } from "./ResultsTabs";
import { resultsAtom } from "./results";
import { SiteHeader } from "./SiteHeader";
import "./app.css";

const NO_RUNS: readonly Run[] = [];

function ResultsLoading() {
  return (
    <div className="results-loading" role="status">
      <span className="loading-line" />
      <p>Loading results…</p>
    </div>
  );
}

function ResultsError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <section className="results-error" role="alert">
      <span className="state-symbol" aria-hidden="true">
        !
      </span>
      <h2>Couldn’t load results.</h2>
      <p>Results could not be fetched or did not pass validation. Try loading them again.</p>
      <button type="button" className="button secondary" disabled={retrying} onClick={onRetry}>
        Try again <span aria-hidden="true">↻</span>
      </button>
    </section>
  );
}

export function App() {
  const result = useAtomValue(resultsAtom);
  const refresh = useAtomRefresh(resultsAtom);
  const bridge = useBridge();
  // A finished run may have appended to the history, so read it again. This also fires once
  // for a run that finished before the page loaded; that extra read is harmless.
  const job = bridge.connection.kind === "local" ? bridge.connection.status.job : null;
  const finishedJobId = job !== null && job.status !== "running" ? job.id : null;
  useEffect(() => {
    if (finishedJobId !== null) refresh();
  }, [finishedJobId, refresh]);
  const [view, update] = useResultsView();
  const [setupOpen, setSetupOpen] = useState(false);
  // Result.value falls back to the last success, so a failed refresh keeps the runs on screen.
  const results = Option.getOrUndefined(Result.value(result));
  const runs = results?.runs ?? NO_RUNS;
  const styles = useMemo(() => modelStyles(runs), [runs]);
  const evidence = useMemo(
    () => collectEvidence(runs, view.tab === "history" ? view.through : null),
    [runs, view.tab, view.through],
  );
  const history = useMemo(() => evidenceHistory(runs), [runs]);

  // The published site is read-only: only the dev server can run benchmarks.
  const openSetup = bridge.connection.kind === "published" ? undefined : () => setSetupOpen(true);
  const panel = () => {
    if (view.tab === "method") return <MethodPage />;
    if (results === undefined)
      return Result.isFailure(result) ? (
        <ResultsError retrying={result.waiting} onRetry={refresh} />
      ) : (
        <ResultsLoading />
      );
    if (runs.length === 0)
      return <EmptyResults onNew={openSetup} onMethod={() => update({ tab: "method" })} />;
    if (view.tab === "history")
      return (
        <HistoryPage
          evidence={evidence}
          history={history}
          styles={styles}
          view={view}
          update={update}
        />
      );
    return <CalibrationPage evidence={evidence} styles={styles} view={view} update={update} />;
  };

  return (
    <div className="results">
      <a className="skip-link" href={`#${PANEL_ID}`}>
        Skip to results
      </a>
      <SiteHeader connection={bridge.connection} onOpenSetup={openSetup} />
      <main>
        <h1 className="sr-only">ProbaBench results</h1>
        <ResultsTabs view={view} update={update} />
        <div id={PANEL_ID} className="results-panel" tabIndex={-1}>
          {panel()}
        </div>
      </main>
      {openSetup ? (
        <RunSetup
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          bridge={bridge}
          modelSuggestions={runs.map((run) => run.modelSlug)}
          onViewResults={() => {
            setSetupOpen(false);
            update({ tab: "calibration", model: null, through: null, hidden: [] });
            document.getElementById(PANEL_ID)?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
