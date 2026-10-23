import { Result, useRxRefresh, useRxValue } from "@effect-rx/rx-react";
import type { Run } from "@probabench/domain";
import { useEffect, useMemo, useState } from "react";
import { useBridge } from "../bridge/use-bridge";
import { CalibrationPage } from "../calibration/CalibrationPage";
import { modelStyles } from "../common/palette";
import { resultsRx } from "../common/results";
import { HistoryPage } from "../history/HistoryPage";
import { MethodPage } from "../method/MethodPage";
import { RunSetup } from "../setup/RunSetup";
import { EmptyNotebook } from "./EmptyNotebook";
import { Hero } from "./Hero";
import { NotebookTabs } from "./NotebookTabs";
import { PANEL_ID, useNotebookView } from "./notebook-view";
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

function NotebookError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="notebook-error" role="alert">
      <span className="state-symbol">!</span>
      <h2>The notebook couldn’t be read.</h2>
      <p>Results could not be fetched or did not pass validation. Try loading them again.</p>
      <button type="button" className="button secondary" onClick={onRetry}>
        Try again <span aria-hidden="true">↻</span>
      </button>
    </section>
  );
}

export function App() {
  const result = useRxValue(resultsRx);
  const refresh = useRxRefresh(resultsRx);
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
  const runs = Result.isSuccess(result) ? result.value.runs : NO_RUNS;
  const styles = useMemo(() => modelStyles(runs), [runs]);

  // The published site is read-only: only the dev server can run benchmarks.
  const openSetup = bridge.connection.kind === "published" ? undefined : () => setSetupOpen(true);
  const panel = () => {
    if (view.tab === "method") return <MethodPage />;
    if (Result.isInitial(result)) return <NotebookLoading />;
    if (Result.isFailure(result)) return <NotebookError onRetry={refresh} />;
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
        <Hero runs={runs} />
        <NotebookTabs runCount={runs.length} view={view} update={update} />
        <div id={PANEL_ID} className="notebook-panel" tabIndex={-1}>
          {panel()}
        </div>
      </main>
      <footer className="site-footer">
        <span className="footer-brand">
          probabench <span> / </span> OpenRouter sampling benchmarks
        </span>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            update({ tab: "method" });
            document.getElementById(PANEL_ID)?.scrollIntoView();
          }}
        >
          About the method <span aria-hidden="true">↗</span>
        </button>
      </footer>
      {openSetup ? (
        <RunSetup
          open={setupOpen}
          onClose={() => setSetupOpen(false)}
          bridge={bridge}
          modelSuggestions={runs.map((run) => run.modelSlug)}
          onViewResults={() => {
            setSetupOpen(false);
            update({ tab: "history", runId: null, query: "", hidden: [] });
            document.getElementById(PANEL_ID)?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
