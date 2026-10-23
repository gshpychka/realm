import {
  MODEL_ALIASES,
  planBudget,
  REASONING_LABELS,
  ReasoningMode,
  SAMPLING_PRESETS,
  StepPercent,
  TrialsPerStep,
} from "@probabench/domain";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  BenchRequest,
  BROWSER_LIMITS,
  BridgeRequest,
  firstIssue,
  type Job,
} from "../bridge/protocol";
import type { Bridge } from "../bridge/use-bridge";
import { number, time } from "../common/format";
import {
  type BenchmarkDraft,
  benchmarkCommand,
  DEFAULT_REQUEST,
  PRESET_DESCRIPTIONS,
  presetFor,
} from "./run-settings";

function JobProgress({
  job,
  bridge,
  onViewResults,
  onSetUpAnother,
  onClose,
}: {
  job: Job;
  bridge: Bridge;
  onViewResults: () => void;
  onSetUpAnother: () => void;
  onClose: () => void;
}) {
  const log = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const [cancelling, setCancelling] = useState(false);
  const progress = job.progress;
  const running = job.status === "running";
  const reconnecting = bridge.connection.kind === "local" && bridge.connection.reconnecting;
  useEffect(() => {
    if (job.log && follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [job.log]);
  useEffect(() => {
    if (job.status !== "running") setCancelling(false);
  }, [job.status]);
  const cancel = async () => {
    setCancelling(true);
    if (!(await bridge.cancel())) setCancelling(false);
  };
  return (
    <section className="job-progress" aria-label="Benchmark progress">
      <div className="job-status" role="status">
        <span className={`status-dot ${running ? "pulse" : ""}`} />
        <strong>
          {running
            ? cancelling
              ? "Stopping the benchmark…"
              : "Sampling in progress"
            : job.status === "completed"
              ? "Run saved to history"
              : job.status === "cancelled"
                ? "Run cancelled"
                : "Run stopped"}
        </strong>
        <p>
          {running
            ? progress
              ? `${progress.completed} of ${progress.total} probability targets sampled.`
              : "Preparing the model and sampling plan."
            : job.status === "completed"
              ? "Your new observation is ready. Earlier runs remain in history."
              : "Any model sweeps already saved remain in history."}
        </p>
        <span className="muted">Started {time(job.startedAt)} UTC</span>
        {reconnecting ? (
          <span className="muted">The dev bridge is not answering. Reconnecting…</span>
        ) : null}
      </div>
      {running ? (
        <progress
          aria-label="Probability targets sampled"
          value={progress?.completed}
          max={progress?.total ?? 1}
        />
      ) : null}
      {job.error ? (
        <p role="alert" className="form-error">
          {job.error}
        </p>
      ) : null}
      {bridge.error ? (
        <p role="alert" className="form-error">
          {bridge.error}
        </p>
      ) : null}
      <div className="job-actions">
        {running ? (
          <>
            <button type="button" className="button secondary" onClick={onClose}>
              Keep running in background
            </button>
            <button
              type="button"
              className="text-button danger"
              disabled={bridge.pending || cancelling}
              onClick={() => {
                void cancel();
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button primary"
              onClick={job.status === "completed" ? onViewResults : onSetUpAnother}
            >
              {job.status === "completed" ? "View results" : "Set up another benchmark"}
              <span aria-hidden="true">↗</span>
            </button>
            <button
              type="button"
              className="text-button"
              onClick={job.status === "completed" ? onSetUpAnother : onViewResults}
            >
              {job.status === "completed" ? "Set up another" : "View saved history"}
            </button>
          </>
        )}
      </div>
      <details className="job-output" open={job.status === "failed"}>
        <summary>Runner output</summary>
        <pre
          ref={log}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the runner output.
          tabIndex={0}
          role="log"
          aria-live="off"
          aria-label="Runner output"
          onScroll={() => {
            const element = log.current;
            if (element)
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          {job.log || "Preparing the sampling plan…"}
        </pre>
      </details>
    </section>
  );
}

export function RunSetup({
  open,
  onClose,
  onViewResults,
  bridge,
  modelSuggestions,
  draft,
}: {
  open: boolean;
  onClose: () => void;
  onViewResults: () => void;
  bridge: Bridge;
  modelSuggestions: readonly string[];
  draft?: BenchmarkDraft;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const commandField = useRef<HTMLTextAreaElement>(null);
  const consumedDraft = useRef(draft?.key);
  const initial = draft ?? DEFAULT_REQUEST;
  const [model, setModel] = useState(initial.model);
  const [trialsPerStep, setTrialsPerStep] = useState(initial.trialsPerStep);
  const [stepPercent, setStepPercent] = useState(initial.stepPercent);
  const [concurrency, setConcurrency] = useState(initial.concurrency);
  const [reasoning, setReasoning] = useState<ReasoningMode | "">(initial.reasoning ?? "");
  const [custom, setCustom] = useState(draft !== undefined && !presetFor(draft));
  const [showJob, setShowJob] = useState(draft === undefined);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  // The custom inputs can hold 0 or NaN while the user types.
  const budget =
    Schema.is(TrialsPerStep)(trialsPerStep) && Schema.is(StepPercent)(stepPercent)
      ? planBudget({ trialsPerStep, stepPercent })
      : { points: 0, samples: 0, attempts: 0 };
  const request = {
    model: model.trim(),
    trialsPerStep,
    stepPercent,
    concurrency,
    ...(reasoning ? { reasoning } : {}),
  };
  const command = benchmarkCommand(request);
  const { connection } = bridge;
  const published = connection.kind === "published";
  const local = connection.kind === "local" ? connection.status : null;
  const localReady = local?.configured === true;
  // A copied command only has to be one the form can express; a browser run also has a budget.
  const checked = Schema.validateEither(published ? BenchRequest : BridgeRequest)(request);
  const validationError = Either.isLeft(checked) ? firstIssue(checked.left) : null;
  const job = local?.job;
  const showingJob = job && (job.status === "running" || showJob);
  const selectedPreset = presetFor(request)?.id;
  const canSubmit = !bridge.pending && !validationError && (published || localReady);

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => {
    if (!draft || consumedDraft.current === draft.key) return;
    consumedDraft.current = draft.key;
    setModel(draft.model);
    setTrialsPerStep(draft.trialsPerStep);
    setStepPercent(draft.stepPercent);
    setConcurrency(draft.concurrency);
    setReasoning(draft.reasoning ?? "");
    setCustom(!presetFor(draft));
    setShowJob(false);
  }, [draft]);
  useEffect(() => {
    if (job?.status === "running") setShowJob(true);
  }, [job?.status]);
  useEffect(() => {
    if (command) {
      setCopied(false);
      setCopyError(false);
    }
  }, [command]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
      requestAnimationFrame(() => {
        commandField.current?.focus();
        commandField.current?.select();
      });
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (published) await copy();
    else if (await bridge.start(request)) setShowJob(true);
  };
  const preview = (
    <>
      <p className="helper">
        In the Realm infra shell (<code>nix develop .#infra</code>). The CLI previews the plan and
        asks for confirmation.
      </p>
      <textarea
        ref={commandField}
        aria-label="Benchmark terminal command"
        readOnly
        value={command}
        rows={3}
        onFocus={(event) => event.currentTarget.select()}
      />
      {!published ? (
        <button
          type="button"
          className="button secondary compact"
          disabled={!!validationError}
          onClick={() => {
            void copy();
          }}
        >
          {copied ? "Copied ✓" : "Copy command"}
        </button>
      ) : null}
      <span role="status" className="helper copy-status">
        {copyError
          ? "Command selected. Use your system’s copy shortcut."
          : copied
            ? "Ready to paste into your terminal."
            : ""}
      </span>
    </>
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog Escape/cancel handling below is the keyboard equivalent of dismissing its backdrop.
    <dialog
      ref={dialog}
      className="run-dialog"
      aria-labelledby="setup-title"
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-content">
        <header className="dialog-heading">
          <div>
            <p className="eyebrow">{showingJob ? "Your observation" : "A new observation"}</p>
            <h2 id="setup-title">
              {showingJob
                ? job.status === "running"
                  ? "Benchmark in progress."
                  : "Benchmark update."
                : "Set up a benchmark."}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button close-button"
            aria-label="Close benchmark setup"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {showingJob ? (
          <JobProgress
            job={job}
            bridge={bridge}
            onViewResults={onViewResults}
            onSetUpAnother={() => setShowJob(false)}
            onClose={onClose}
          />
        ) : (
          <>
            <p className="dialog-intro">
              Choose a model and a sampling depth. Every completed run is saved alongside earlier
              observations.
            </p>
            <form
              onSubmit={(event) => {
                void submit(event);
              }}
            >
              <label className="field-label" htmlFor="benchmark-model">
                OpenRouter model <span>provider/model or starter alias</span>
              </label>
              <input
                id="benchmark-model"
                name="model"
                type="text"
                list="starter-models"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="anthropic/claude-haiku-4.5"
                required
                maxLength={BROWSER_LIMITS.modelLength}
                autoComplete="off"
                spellCheck={false}
                disabled={bridge.pending}
              />
              <datalist id="starter-models">
                {MODEL_ALIASES.map((alias) => (
                  <option
                    key={alias.alias}
                    value={alias.alias}
                    label={
                      alias.reasoning ? `${alias.slug} · ${alias.reasoning} reasoning` : alias.slug
                    }
                  />
                ))}
                {[...new Set(modelSuggestions)]
                  .filter(
                    (slug) =>
                      slug.length <= BROWSER_LIMITS.modelLength &&
                      !MODEL_ALIASES.some((alias) => alias.alias === slug),
                  )
                  .map((slug) => (
                    <option key={slug} value={slug} />
                  ))}
              </datalist>
              <p className="helper">Use any OpenRouter model ID.</p>
              <fieldset className="preset-fieldset">
                <legend className="field-label">Sampling depth</legend>
                <div className="preset-grid">
                  {SAMPLING_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={selectedPreset === preset.id}
                      className={`preset ${selectedPreset === preset.id ? "selected" : ""}`}
                      disabled={bridge.pending}
                      onClick={() => {
                        setTrialsPerStep(preset.trialsPerStep);
                        setStepPercent(preset.stepPercent);
                        setCustom(false);
                      }}
                    >
                      <strong>{preset.label}</strong>
                      <span>{PRESET_DESCRIPTIONS[preset.id]}</span>
                      <small>{number(planBudget(preset).samples)} samples</small>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="text-button setup-custom"
                  aria-expanded={custom}
                  aria-controls="custom-sampling"
                  disabled={bridge.pending}
                  onClick={() => setCustom((value) => !value)}
                >
                  {custom
                    ? "Hide custom settings"
                    : selectedPreset
                      ? "Choose a custom budget"
                      : "Edit custom budget"}
                  <span aria-hidden="true">{custom ? "−" : "+"}</span>
                </button>
              </fieldset>
              {custom ? (
                <div className="form-grid" id="custom-sampling">
                  <label className="field-label" htmlFor="benchmark-trials">
                    Samples / target
                    <input
                      id="benchmark-trials"
                      type="number"
                      min={1}
                      max={BROWSER_LIMITS.trialsPerStep}
                      step={1}
                      value={trialsPerStep}
                      onChange={(event) => setTrialsPerStep(Number(event.target.value))}
                      required
                      disabled={bridge.pending}
                    />
                  </label>
                  <label className="field-label" htmlFor="benchmark-step">
                    Target step <span>%</span>
                    <input
                      id="benchmark-step"
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={stepPercent}
                      onChange={(event) => setStepPercent(Number(event.target.value))}
                      required
                      disabled={bridge.pending}
                    />
                  </label>
                </div>
              ) : null}
              <details className="advanced">
                <summary>
                  Advanced settings <span>Concurrency & reasoning</span>
                </summary>
                <div className="form-grid">
                  <label className="field-label" htmlFor="benchmark-concurrency">
                    Concurrent requests
                    <input
                      id="benchmark-concurrency"
                      type="number"
                      min={1}
                      max={BROWSER_LIMITS.concurrency}
                      step={1}
                      value={concurrency}
                      onChange={(event) => setConcurrency(Number(event.target.value))}
                      required
                      disabled={bridge.pending}
                    />
                  </label>
                  <label className="field-label" htmlFor="benchmark-reasoning">
                    Reasoning
                    <select
                      id="benchmark-reasoning"
                      value={reasoning}
                      onChange={(event) => {
                        const value = event.target.value;
                        setReasoning(Schema.is(ReasoningMode)(value) ? value : "");
                      }}
                      disabled={bridge.pending}
                    >
                      <option value="">Use runner preset</option>
                      {ReasoningMode.literals.map((mode) => (
                        <option key={mode} value={mode}>
                          {REASONING_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="helper">
                  Named aliases retain their reasoning settings. A raw model slug uses reasoning off
                  unless you choose a mode.
                </p>
              </details>
              <div className="budget" aria-live="polite">
                <div>
                  <strong>{number(budget.samples)}</strong>
                  <span>planned samples</span>
                </div>
                <span className="budget-times">=</span>
                <p>
                  {number(budget.points)} targets × {number(trialsPerStep)} samples
                  <br />
                  <span>Up to {number(budget.attempts)} attempts with retries.</span>
                </p>
              </div>
              {validationError ? (
                <p role="alert" className="form-error">
                  {validationError}
                </p>
              ) : null}
              {local && !local.configured ? (
                <div className="environment-note">
                  <span className="status-dot" />
                  <div>
                    <strong>Connect your OpenRouter key</strong>
                    <p>
                      This dev server has no <code>OPENROUTER_API_KEY</code>. Restart it with{" "}
                      <code>bun run dev</code>, which decrypts{" "}
                      <code>secrets/infra/probabench.env</code>.
                    </p>
                  </div>
                </div>
              ) : null}
              {bridge.error ? (
                <p role="alert" className="form-error">
                  {bridge.error}
                </p>
              ) : null}
              <div className="run-action">
                <p>
                  {published
                    ? "Run this command locally with your OpenRouter key. Charges depend on generated tokens."
                    : "Your key stays on the local server. OpenRouter charges for generated tokens."}
                </p>
                <button type="submit" className="button primary" disabled={!canSubmit}>
                  {connection.kind === "connecting"
                    ? "Checking runner…"
                    : bridge.pending
                      ? "Starting…"
                      : published
                        ? copied
                          ? "Copied ✓"
                          : "Copy command"
                        : "Start benchmark"}
                  <span aria-hidden="true">{published ? "⧉" : "↗"}</span>
                </button>
              </div>
              {published ? (
                <section
                  className="terminal-command published-command"
                  aria-label="Run from your terminal"
                >
                  {preview}
                </section>
              ) : null}
              {published ? (
                <p className="helper setup-local-link">
                  To run benchmarks from this page, start <code>bun run dev</code> in your local
                  workspace and open its local URL.
                </p>
              ) : null}
            </form>
            {!published ? (
              <details className="terminal-command" open={copyError}>
                <summary>Use the terminal instead</summary>
                {preview}
              </details>
            ) : null}
          </>
        )}
      </div>
    </dialog>
  );
}
