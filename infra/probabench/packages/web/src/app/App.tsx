import { Result, useAtomRefresh, useAtomValue } from "@effect-atom/atom-react";
import type { Run } from "@probabench/domain";
import * as Option from "effect/Option";
import { useEffect, useMemo, useState } from "react";
import { useBridge } from "../bridge/use-bridge";
import { CalibrationPage } from "../calibration/CalibrationPage";
import { PANEL_ID, useNotebookView } from "../common/notebook-view";
import { modelStyles } from "../common/palette";
import { HistoryPage } from "../history/HistoryPage";
import { MethodPage } from "../method/MethodPage";
import { RunSetup } from "../setup/RunSetup";
import { EmptyNotebook } from "./EmptyNotebook";
import { Masthead } from "./Masthead";
import { NotebookTabs } from "./NotebookTabs";
import { resultsAtom } from "./results";
import { SiteHeader } from "./SiteHeader";
import "./app.css";

const NO_RUNS: readonly Run[] = [];

function NotebookLoading() {
  return (
    <div className="notebook-loading" role="status">
      <span className="loading-line" />
      <p>Opening the notebook…</p>
      <span className="loading-detail">Reading the saved runs.</span>
    </div>
  );
}

function NotebookError({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <section className="notebook-error" role="alert">
      <span className="state-symbol" aria-hidden="true">
        !
      </span>
      <h2>The notebook couldn’t be read.</h2>
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
  const [view, update] = useNotebookView();
  const [setupOpen, setSetupOpen] = useState(false);
  // Result.value falls back to the last success, so a failed refresh keeps the runs on screen.
  const results = Option.getOrUndefined(Result.value(result));
  const runs = results?.runs ?? NO_RUNS;
  const styles = useMemo(() => modelStyles(runs), [runs]);

  // The published site is read-only: only the dev server can run benchmarks.
  const openSetup = bridge.connection.kind === "published" ? undefined : () => setSetupOpen(true);
  const panel = () => {
    if (view.tab === "method") return <MethodPage />;
    if (results === undefined)
      return Result.isFailure(result) ? (
        <NotebookError retrying={result.waiting} onRetry={refresh} />
      ) : (
        <NotebookLoading />
      );
    if (runs.length === 0)
      return <EmptyNotebook onNew={openSetup} onMethod={() => update({ tab: "method" })} />;
    if (view.tab === "history")
      return <HistoryPage runs={runs} styles={styles} view={view} update={update} />;
    return <CalibrationPage runs={runs} styles={styles} view={view} update={update} />;
  };

  return (
    <div className="notebook">
      <a className="skip-link" href={`#${PANEL_ID}`}>
        Skip to notebook
      </a>
      <SiteHeader connection={bridge.connection} onOpenSetup={openSetup} />
      <main>
        <Masthead runs={runs} />
        <NotebookTabs runCount={runs.length} view={view} update={update} />
        <div id={PANEL_ID} className="notebook-panel" tabIndex={-1}>
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
            update({ tab: "history", runId: null, hidden: [] });
            document.getElementById(PANEL_ID)?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
