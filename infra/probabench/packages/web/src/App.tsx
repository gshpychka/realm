import { Result, useRxRefresh, useRxValue } from "@effect-rx/rx-react";
import { type Run, summarizeRun } from "@probabench/domain";
import { type KeyboardEvent, lazy, Suspense, useEffect, useState } from "react";
import { type Connection, useBridge } from "./bridge/use-bridge";
import { date, number, time } from "./format";
import { groupHistory, newestFirst, selectedRuns, visibleHistory } from "./history";
import { LoadBoundary } from "./LoadBoundary";
import { useNotebookView } from "./notebook-view";
import { resultsRx } from "./results";
import { type BenchmarkDraft, rerunRequest } from "./setup/run-settings";

const Method = lazy(() => import("./Method").then((module) => ({ default: module.Method })));
const Workspace = lazy(() =>
  import("./Workspace").then((module) => ({ default: module.Workspace })),
);
const RunSetup = lazy(() => import("./RunSetup").then((module) => ({ default: module.RunSetup })));
const TABS = [
  { id: "calibration", label: "Calibration" },
  { id: "history", label: "Run history" },
  { id: "method", label: "Method" },
] as const;
const CONNECTION_LABEL = {
  published: "Published notebook",
  connecting: "Connecting",
  local: "Local workspace",
} as const satisfies Record<Connection["kind"], string>;
function NotebookLoading() {
  return (
    <div className="notebook-loading" role="status">
      <span className="loading-line" />
      <p>Opening the notebook…</p>
      <span>Reading the recorded observations.</span>
    </div>
  );
}

function ReferenceSketch() {
  return (
    <svg viewBox="0 0 160 100" fill="none" aria-hidden="true">
      <path d="M22 10V80H150" stroke="currentColor" opacity=".25" />
      <path d="M22 80L143 14" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 5" />
      <text x="17" y="97" fill="currentColor" fontSize="8" fontFamily="monospace">
        0
      </text>
      <text x="143" y="97" fill="currentColor" fontSize="8" fontFamily="monospace">
        1
      </text>
      <text
        x="80"
        y="33"
        fill="currentColor"
        fontSize="12"
        fontFamily="Georgia, serif"
        fontStyle="italic"
      >
        y = x
      </text>
    </svg>
  );
}

function EmptyNotebook({ onNew, onMethod }: { onNew: () => void; onMethod: () => void }) {
  return (
    <section className="empty-notebook" role="status">
      <div className="empty-sketch">
        <ReferenceSketch />
      </div>
      <h2>Start with one model.</h2>
      <p>
        Choose a model, collect its samples, and see how closely it follows the probabilities you
        ask for. Each run becomes part of the history.
      </p>
      <div className="empty-actions">
        <button type="button" className="button primary" onClick={onNew}>
          New benchmark <span aria-hidden="true">↗</span>
        </button>
        <button type="button" className="text-button" onClick={onMethod}>
          Read the method <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  );
}

export function App() {
  const result = useRxValue(resultsRx);
  const refresh = useRxRefresh(resultsRx);
  const bridge = useBridge(refresh);
  const local = bridge.connection.kind === "local" ? bridge.connection.status : null;
  const running = local?.job?.status === "running";
  const [view, update] = useNotebookView();
  const tab = view.tab;
  const [setup, setSetup] = useState(false);
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [draft, setDraft] = useState<BenchmarkDraft | undefined>();
  const [linkStatus, setLinkStatus] = useState<{ url: string; message: string } | null>(null);
  useEffect(() => {
    if (linkStatus?.message !== "View link copied") return;
    const timer = setTimeout(() => setLinkStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [linkStatus]);
  const openSetup = () => {
    setSetupLoaded(true);
    setSetup(true);
  };
  const repeatRun = (run: Run) => {
    const request = rerunRequest(run);
    if (request === null) return;
    setDraft({ ...request, key: crypto.randomUUID() });
    openSetup();
  };
  const copyView = async () => {
    // Sharing freezes the visible snapshots instead of silently following future "latest" runs.
    if (view.tab === "calibration") {
      const explicit = new Map(
        runs.filter((run) => view.comparisons.includes(run.id)).map((run) => [run.model, run.id]),
      );
      update(
        { comparisons: selectedRuns(groupHistory(runs), explicit, new Set()).map((run) => run.id) },
        "replace",
      );
    } else if (view.tab === "history") {
      const visible = visibleHistory(runs, view.query, view.hidden);
      update(
        { runId: (visible.find((run) => run.id === view.runId) ?? visible[0])?.id ?? null },
        "replace",
      );
    }
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setLinkStatus({ url, message: "View link copied" });
    } catch {
      setLinkStatus({
        url,
        message: "Copy this page’s address from your browser to share the view.",
      });
    }
  };
  const results = Result.match(result, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: (success) => success.value,
  });
  const runs = results?.runs ?? [];
  const models = new Set(runs.map((run) => run.model));
  const valid = runs.reduce((sum, run) => sum + summarizeRun(run).valid, 0);
  const latest = newestFirst(runs)[0];
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % TABS.length
        : event.key === "ArrowLeft"
          ? (index + TABS.length - 1) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      const item = TABS[next];
      if (item) {
        update({ tab: item.id });
        document.getElementById(`tab-${item.id}`)?.focus();
      }
    }
  };
  return (
    <div className={`notebook ${runs.length > 0 ? "has-results" : ""}`}>
      <a className="skip-link" href="#notebook-content">
        Skip to notebook
      </a>
      <header className="site-header">
        <a className="brand" href="./" aria-label="ProbaBench home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          proba<span>bench</span>
        </a>
        <div className="header-actions">
          {running ? (
            <button type="button" className="connection running" onClick={openSetup}>
              <span className="status-dot pulse" />
              Benchmark running
            </button>
          ) : (
            <span className="connection">
              <span className={`status-dot ${local?.configured ? "ready" : ""}`} />
              {CONNECTION_LABEL[bridge.connection.kind]}
            </span>
          )}
          <button type="button" className="button primary" onClick={openSetup}>
            {running ? "View progress" : "New benchmark"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            {runs.length > 0 ? (
              <>
                <h1>A sampling notebook.</h1>
                <p>How closely do language models follow a probability?</p>
              </>
            ) : (
              <>
                <p className="eyebrow">Language models, under observation</p>
                <h1>
                  Can a model <em>keep a probability?</em>
                </h1>
                <p>
                  Ask for a 1 with probability <var>x</var>. Measure what comes back.
                </p>
              </>
            )}
          </div>
          {runs.length === 0 ? (
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
          ) : null}
        </section>
        {runs.length > 0 ? (
          <section className="notebook-overview" aria-label="Notebook totals">
            <dl>
              <div>
                <dt>Saved runs</dt>
                <dd>{number(runs.length)}</dd>
              </div>
              <div>
                <dt>Models observed</dt>
                <dd>{number(models.size)}</dd>
              </div>
              <div>
                <dt>Valid samples</dt>
                <dd>{number(valid)}</dd>
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
        ) : null}
        <div className="notebook-navigation">
          <div role="tablist" aria-label="Notebook views">
            {TABS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`tab-${item.id}`}
                aria-selected={tab === item.id}
                aria-controls="notebook-content"
                tabIndex={tab === item.id ? 0 : -1}
                onKeyDown={(event) => tabKey(event, index)}
                onClick={() => update({ tab: item.id })}
              >
                {item.label}
                {item.id === "history" && runs.length > 0 ? (
                  <span className="tab-count">{number(runs.length)}</span>
                ) : null}
              </button>
            ))}
          </div>
          {runs.length > 0 ? (
            <div className="view-actions">
              <button
                type="button"
                className="text-button share-view"
                aria-label="Copy view link"
                onClick={() => {
                  void copyView();
                }}
              >
                <span className="share-label">Copy view link</span>
                <svg
                  className="copy-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <rect x="8" y="8" width="12" height="12" rx="2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                </svg>
              </button>
              <span role="status" className="copy-status">
                {linkStatus?.url === window.location.href ? linkStatus.message : ""}
              </span>
            </div>
          ) : null}
        </div>
        <div id="notebook-content" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={-1}>
          {tab === "method" ? (
            <LoadBoundary surface="notebook">
              <Suspense fallback={<NotebookLoading />}>
                <Method />
              </Suspense>
            </LoadBoundary>
          ) : (
            Result.match(result, {
              onInitial: () => <NotebookLoading />,
              onFailure: () => (
                <section className="notebook-error" role="alert">
                  <span className="state-symbol">!</span>
                  <h2>The notebook couldn’t be read.</h2>
                  <p>
                    Results could not be fetched or did not pass validation. Try loading them again.
                  </p>
                  <button type="button" className="button secondary" onClick={refresh}>
                    Try again <span aria-hidden="true">↻</span>
                  </button>
                </section>
              ),
              onSuccess: (success) =>
                success.value.runs.length === 0 ? (
                  <EmptyNotebook onNew={openSetup} onMethod={() => update({ tab: "method" })} />
                ) : (
                  <LoadBoundary surface="notebook">
                    <Suspense fallback={<NotebookLoading />}>
                      <Workspace
                        results={success.value}
                        view={view}
                        update={update}
                        onRerun={repeatRun}
                      />
                    </Suspense>
                  </LoadBoundary>
                ),
            })
          )}
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
            document.getElementById("notebook-content")?.scrollIntoView({
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "instant"
                : "smooth",
            });
          }}
        >
          About the method <span aria-hidden="true">↗</span>
        </button>
      </footer>
      {setupLoaded ? (
        <LoadBoundary surface="setup">
          <Suspense
            fallback={
              <p className="setup-pending" role="status">
                Opening benchmark setup…
              </p>
            }
          >
            <RunSetup
              open={setup}
              onClose={() => setSetup(false)}
              bridge={bridge}
              modelSuggestions={runs.map((run) => run.modelSlug)}
              {...(draft ? { draft } : {})}
              onViewResults={() => {
                setSetup(false);
                update({ tab: "history", runId: null, query: "", hidden: [] });
                document.getElementById("tab-history")?.focus();
              }}
            />
          </Suspense>
        </LoadBoundary>
      ) : null}
    </div>
  );
}
