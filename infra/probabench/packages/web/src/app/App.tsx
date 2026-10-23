import { Result, useRxRefresh, useRxValue } from "@effect-rx/rx-react";
import type { Run } from "@probabench/domain";
import { useMemo, useState } from "react";
import type { BenchRequest } from "../bridge/protocol";
import { useBridge } from "../bridge/use-bridge";
import { CalibrationPage } from "../calibration/CalibrationPage";
import { modelStyles } from "../common/palette";
import { resultsRx } from "../common/results";
import { HistoryPage } from "../history/HistoryPage";
import { MethodPage } from "../method/MethodPage";
import { RunSetup } from "../setup/RunSetup";
import type { BenchmarkDraft } from "../setup/run-settings";
import { EmptyNotebook } from "./EmptyNotebook";
import { Hero } from "./Hero";
import { NotebookTabs } from "./NotebookTabs";
import { PANEL_ID, tabId, useNotebookView } from "./notebook-view";
import { SiteHeader } from "./SiteHeader";

const NO_RUNS: readonly Run[] = [];

function NotebookLoading() {
  return (
    <div className="notebook-loading" role="status">
      <span className="loading-line" />
      <p>Opening the notebook…</p>
      <span>Reading the recorded observations.</span>
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
  const bridge = useBridge(refresh);
  const [view, update] = useNotebookView();
  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState<BenchmarkDraft | undefined>();
  const runs = Result.isSuccess(result) ? result.value.runs : NO_RUNS;
  const styles = useMemo(() => modelStyles(runs), [runs]);

  const openSetup = () => setSetupOpen(true);
  const rerun = (request: BenchRequest) => {
    setDraft({ ...request, key: crypto.randomUUID() });
    openSetup();
  };
  const panel = () => {
    if (view.tab === "method") return <MethodPage />;
    if (Result.isInitial(result)) return <NotebookLoading />;
    if (Result.isFailure(result)) return <NotebookError onRetry={refresh} />;
    if (runs.length === 0)
      return <EmptyNotebook onNew={openSetup} onMethod={() => update({ tab: "method" })} />;
    const page = { runs, styles, view, update };
    return view.tab === "history" ? (
      <HistoryPage {...page} onRerun={rerun} />
    ) : (
      <CalibrationPage {...page} />
    );
  };

  return (
    <div className={`notebook ${runs.length > 0 ? "has-results" : ""}`}>
      <a className="skip-link" href={`#${PANEL_ID}`}>
        Skip to notebook
      </a>
      <SiteHeader connection={bridge.connection} onOpenSetup={openSetup} />
      <main>
        <Hero runs={runs} />
        <NotebookTabs runs={runs} view={view} update={update} />
        <div id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(view.tab)} tabIndex={-1}>
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
            document.getElementById(PANEL_ID)?.scrollIntoView({
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "instant"
                : "smooth",
            });
          }}
        >
          About the method <span aria-hidden="true">↗</span>
        </button>
      </footer>
      <RunSetup
        key={draft?.key ?? "new"}
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        bridge={bridge}
        modelSuggestions={runs.map((run) => run.modelSlug)}
        draft={draft}
        onViewResults={() => {
          setSetupOpen(false);
          update({ tab: "history", runId: null, query: "", hidden: [] });
          document.getElementById(tabId("history"))?.focus();
        }}
      />
    </div>
  );
}
