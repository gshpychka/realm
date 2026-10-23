import {
  MODEL_ALIASES,
  planBudget,
  ReasoningMode,
  SAMPLING_PRESETS,
  StepPercent,
  seriesLabel,
  TrialsPerStep,
} from "@probabench/domain";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { type FormEvent, useState } from "react";
import { BenchRequest, BROWSER_LIMITS, firstIssue } from "../bridge/protocol";
import type { Bridge, Connection } from "../bridge/use-bridge";
import { count } from "../common/format";
import { FormError } from "./FormError";
import { presetFor, type Settings } from "./settings";

const submitLabel = (connection: Connection["kind"], pending: boolean): string =>
  connection === "connecting" ? "Connecting…" : pending ? "Starting…" : "Start benchmark";

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
  const [startError, setStartError] = useState<string | null>(null);
  const { model, trialsPerStep, stepPercent, concurrency, reasoning, custom } = settings;
  const request = {
    model: model.trim(),
    trialsPerStep,
    stepPercent,
    concurrency,
    ...(reasoning ? { reasoning } : {}),
  };
  const { connection } = bridge;
  const local = connection.kind === "local" ? connection.status : null;
  const budget =
    Schema.is(TrialsPerStep)(trialsPerStep) && Schema.is(StepPercent)(stepPercent)
      ? planBudget({ trialsPerStep, stepPercent })
      : { points: 0, samples: 0 };
  const checked = Schema.validateEither(BenchRequest)(request);
  const validationError = Either.isLeft(checked) ? firstIssue(checked.left) : null;
  const selectedPreset = presetFor(request);
  const canSubmit = !bridge.pending && !validationError && local?.configured === true;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSubmit) setStartError(await bridge.start(request));
  };

  return (
    <>
      <p className="dialog-intro">
        Choose a model and a sample budget. Every completed run is saved alongside earlier runs.
      </p>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {/* Locks every setting while a run is starting; display: contents keeps the layout. */}
        <fieldset className="setup-fields" disabled={bridge.pending}>
          <label className="field-label" htmlFor="benchmark-model">
            Model <span>OpenRouter model ID or starter alias</span>
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
            autoComplete="off"
            spellCheck={false}
          />
          <datalist id="starter-models">
            {MODEL_ALIASES.map((alias) => (
              <option
                key={alias.alias}
                value={alias.alias}
                label={seriesLabel(alias.slug, alias.reasoning ?? "off")}
              />
            ))}
            {[...new Set(modelSuggestions)]
              .filter((slug) => !MODEL_ALIASES.some((alias) => alias.alias === slug))
              .map((slug) => (
                <option key={slug} value={slug} />
              ))}
          </datalist>
          <fieldset className="preset-fieldset">
            <legend className="field-label">Sample budget</legend>
            <div className="preset-grid">
              {SAMPLING_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={selectedPreset === preset}
                  className="preset"
                  onClick={() =>
                    onChange({
                      trialsPerStep: preset.trialsPerStep,
                      stepPercent: preset.stepPercent,
                      custom: false,
                    })
                  }
                >
                  <strong>{preset.label}</strong>
                  <span>{preset.description}</span>
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
              Custom budget
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
                  <option value="">Default</option>
                  {ReasoningMode.literals.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="helper">
              Default keeps an alias’s own reasoning mode and turns reasoning off for a model ID.
            </p>
          </details>
        </fieldset>
        <div className="budget" aria-live="polite">
          <div className="budget-total">
            <strong>{count(budget.samples)}</strong>
            <span>planned samples</span>
          </div>
          <span className="budget-times">=</span>
          <p>
            {count(budget.points)} targets × {count(trialsPerStep)} samples
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
        <FormError message={startError} />
        <div className="run-action">
          <p>Your key stays on the dev server. OpenRouter charges for generated tokens.</p>
          <button type="submit" className="button primary" disabled={!canSubmit}>
            {submitLabel(connection.kind, bridge.pending)}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </form>
    </>
  );
}
