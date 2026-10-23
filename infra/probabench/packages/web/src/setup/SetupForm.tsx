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
import { type FormEvent, type ReactNode, type RefObject, useRef } from "react";
import { BenchRequest, BROWSER_LIMITS, BridgeRequest, firstIssue } from "../bridge/protocol";
import type { Bridge, Connection } from "../bridge/use-bridge";
import { type CopyStatus, useClipboard } from "../common/clipboard";
import { count } from "../common/format";
import { FormError } from "./FormError";
import { benchmarkCommand, DEFAULT_REQUEST, PRESET_DESCRIPTIONS, presetFor } from "./run-settings";

/** What the form edits. Number fields can hold 0 or NaN while the user types. */
export interface Settings {
  readonly model: string;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
  readonly reasoning: ReasoningMode | undefined;
  /** Whether the custom sampling inputs are open. */
  readonly custom: boolean;
}

/** A draft's settings, opening the custom inputs when no preset matches; else the defaults. */
export const initialSettings = (draft: BenchRequest | undefined): Settings => {
  const { model, trialsPerStep, stepPercent, concurrency, reasoning } = draft ?? DEFAULT_REQUEST;
  return {
    model,
    trialsPerStep,
    stepPercent,
    concurrency,
    reasoning,
    custom: draft !== undefined && presetFor(draft) === undefined,
  };
};

export const submitLabel = (
  connection: Connection["kind"],
  pending: boolean,
  copied: boolean,
): string => {
  if (connection === "connecting") return "Checking runner…";
  if (pending) return "Starting…";
  if (connection === "published") return copied ? "Copied ✓" : "Copy command";
  return "Start benchmark";
};

const COPY_MESSAGE = {
  copied: "Ready to paste into your terminal.",
  failed: "Command selected. Use your system’s copy shortcut.",
} as const satisfies Record<CopyStatus, string>;

const customToggleLabel = (custom: boolean, onPreset: boolean): string => {
  if (custom) return "Hide custom settings";
  return onPreset ? "Choose a custom budget" : "Edit custom budget";
};

/** The run as a terminal command; `children` go between the command and the copy status. */
function CommandPreview({
  command,
  field,
  status,
  children,
}: {
  command: string;
  field: RefObject<HTMLTextAreaElement | null>;
  status: CopyStatus | null;
  children?: ReactNode;
}) {
  return (
    <>
      <p className="helper">
        In the Realm infra shell (<code>nix develop .#infra</code>). The CLI previews the plan and
        asks for confirmation.
      </p>
      <textarea
        ref={field}
        aria-label="Benchmark terminal command"
        readOnly
        value={command}
        rows={3}
        onFocus={(event) => event.currentTarget.select()}
      />
      {children}
      <span role="status" className="helper copy-status">
        {status ? COPY_MESSAGE[status] : ""}
      </span>
    </>
  );
}

function NumberField({
  id,
  label,
  unit,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  unit?: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field-label" htmlFor={id}>
      {label} {unit ? <span>{unit}</span> : null}
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        required
      />
    </label>
  );
}

export function SetupForm({
  settings,
  onChange,
  bridge,
  modelSuggestions,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  bridge: Bridge;
  modelSuggestions: readonly string[];
}) {
  const commandField = useRef<HTMLTextAreaElement>(null);
  const { copy, statusOf } = useClipboard();
  const { model, trialsPerStep, stepPercent, concurrency, reasoning, custom } = settings;
  const request = {
    model: model.trim(),
    trialsPerStep,
    stepPercent,
    concurrency,
    ...(reasoning ? { reasoning } : {}),
  };
  const command = benchmarkCommand(request);
  const copyStatus = statusOf(command);
  const { connection } = bridge;
  const published = connection.kind === "published";
  const local = connection.kind === "local" ? connection.status : null;
  const budget =
    Schema.is(TrialsPerStep)(trialsPerStep) && Schema.is(StepPercent)(stepPercent)
      ? planBudget({ trialsPerStep, stepPercent })
      : { points: 0, samples: 0, attempts: 0 };
  // A copied command only has to be one the form can express; a browser run also has a budget.
  const checked = Schema.validateEither(published ? BenchRequest : BridgeRequest)(request);
  const validationError = Either.isLeft(checked) ? firstIssue(checked.left) : null;
  const selectedPreset = presetFor(request)?.id;
  const canSubmit =
    !bridge.pending && !validationError && (published || local?.configured === true);

  const copyCommand = async () => {
    if ((await copy(command)) === "copied") return;
    requestAnimationFrame(() => {
      commandField.current?.focus();
      commandField.current?.select();
    });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (published) await copyCommand();
    else await bridge.start(request);
  };

  return (
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
        {/* Locks every setting while a run is starting; display: contents keeps the layout. */}
        <fieldset className="setup-fields" disabled={bridge.pending}>
          <label className="field-label" htmlFor="benchmark-model">
            OpenRouter model <span>provider/model or starter alias</span>
          </label>
          <input
            id="benchmark-model"
            name="model"
            type="text"
            list="starter-models"
            value={model}
            onChange={(event) => onChange({ model: event.target.value })}
            placeholder="anthropic/claude-haiku-4.5"
            required
            maxLength={BROWSER_LIMITS.modelLength}
            autoComplete="off"
            spellCheck={false}
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
                  onClick={() =>
                    onChange({
                      trialsPerStep: preset.trialsPerStep,
                      stepPercent: preset.stepPercent,
                      custom: false,
                    })
                  }
                >
                  <strong>{preset.label}</strong>
                  <span>{PRESET_DESCRIPTIONS[preset.id]}</span>
                  <small>{count(planBudget(preset).samples)} samples</small>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="text-button setup-custom"
              aria-expanded={custom}
              aria-controls="custom-sampling"
              onClick={() => onChange({ custom: !custom })}
            >
              {customToggleLabel(custom, selectedPreset !== undefined)}
              <span aria-hidden="true">{custom ? "−" : "+"}</span>
            </button>
          </fieldset>
          {custom ? (
            <div className="form-grid" id="custom-sampling">
              <NumberField
                id="benchmark-trials"
                label="Samples / target"
                value={trialsPerStep}
                max={BROWSER_LIMITS.trialsPerStep}
                onChange={(value) => onChange({ trialsPerStep: value })}
              />
              <NumberField
                id="benchmark-step"
                label="Target step"
                unit="%"
                value={stepPercent}
                max={100}
                onChange={(value) => onChange({ stepPercent: value })}
              />
            </div>
          ) : null}
          <details className="advanced">
            <summary>
              Advanced settings <span>Concurrency & reasoning</span>
            </summary>
            <div className="form-grid">
              <NumberField
                id="benchmark-concurrency"
                label="Concurrent requests"
                value={concurrency}
                max={BROWSER_LIMITS.concurrency}
                onChange={(value) => onChange({ concurrency: value })}
              />
              <label className="field-label" htmlFor="benchmark-reasoning">
                Reasoning
                <select
                  id="benchmark-reasoning"
                  value={reasoning ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange({ reasoning: Schema.is(ReasoningMode)(value) ? value : undefined });
                  }}
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
        </fieldset>
        <div className="budget" aria-live="polite">
          <div>
            <strong>{count(budget.samples)}</strong>
            <span>planned samples</span>
          </div>
          <span className="budget-times">=</span>
          <p>
            {count(budget.points)} targets × {count(trialsPerStep)} samples
            <br />
            <span>Up to {count(budget.attempts)} attempts with retries.</span>
          </p>
        </div>
        <FormError message={validationError} />
        {local && !local.configured ? (
          <div className="environment-note">
            <span className="status-dot" />
            <div>
              <strong>Connect your OpenRouter key</strong>
              <p>
                This dev server has no <code>OPENROUTER_API_KEY</code>. Restart it with{" "}
                <code>bun run dev</code>, which decrypts <code>secrets/infra/probabench.env</code>.
              </p>
            </div>
          </div>
        ) : null}
        <FormError message={bridge.error} />
        <div className="run-action">
          <p>
            {published
              ? "Run this command locally with your OpenRouter key. Charges depend on generated tokens."
              : "Your key stays on the local server. OpenRouter charges for generated tokens."}
          </p>
          <button type="submit" className="button primary" disabled={!canSubmit}>
            {submitLabel(connection.kind, bridge.pending, copyStatus === "copied")}
            <span aria-hidden="true">{published ? "⧉" : "↗"}</span>
          </button>
        </div>
        {published ? (
          <>
            <section
              className="terminal-command published-command"
              aria-label="Run from your terminal"
            >
              <CommandPreview command={command} field={commandField} status={copyStatus} />
            </section>
            <p className="helper setup-local-link">
              To run benchmarks from this page, start <code>bun run dev</code> in your local
              workspace and open its local URL.
            </p>
          </>
        ) : null}
      </form>
      {published ? null : (
        <details className="terminal-command" open={copyStatus === "failed"}>
          <summary>Use the terminal instead</summary>
          <CommandPreview command={command} field={commandField} status={copyStatus}>
            <button
              type="button"
              className="button secondary compact"
              disabled={!!validationError}
              onClick={() => {
                void copyCommand();
              }}
            >
              {copyStatus === "copied" ? "Copied ✓" : "Copy command"}
            </button>
          </CommandPreview>
        </details>
      )}
    </>
  );
}
