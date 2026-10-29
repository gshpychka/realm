import { COST_ASSUMPTIONS, type CostEstimate, formatCost } from "@probabench/domain";
import { useEffect, useState } from "react";
import { fetchEstimate } from "../bridge/client";
import type { BenchRequest } from "../bridge/protocol";
import { count } from "../common/format";

export function useCostEstimate(request: BenchRequest | null, enabled: boolean) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    request: BenchRequest;
    revision: number;
    estimate: CostEstimate | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled || request === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchEstimate(request, controller.signal).then(
        (estimate) => {
          if (!controller.signal.aborted) setState({ request, revision, estimate, error: null });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              request,
              revision,
              estimate: null,
              error: error instanceof Error ? error.message : "Could not load the cost estimate.",
            });
        },
      );
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, request, revision]);
  const current = state?.request === request && state.revision === revision ? state : null;
  return {
    estimate: current?.estimate ?? null,
    error: current?.error ?? null,
    pending: enabled && request !== null && current === null,
    refresh: () => {
      setState(null);
      setRevision((value) => value + 1);
    },
  };
}

export function CostPreview({ quote }: { quote: ReturnType<typeof useCostEstimate> }) {
  const { estimate, error, pending, refresh } = quote;
  return (
    <div className="cost-preview" aria-live="polite" aria-busy={pending}>
      <div className="cost-heading">
        <span>Estimated API cost</span>
        <strong>
          {pending ? "Estimating…" : estimate ? formatCost(estimate.cost) : "Unavailable"}
        </strong>
      </div>
      {estimate ? <p>{count(estimate.requests)} new requests</p> : null}
      {estimate?.warning || error ? (
        <p className="form-error">{estimate?.warning ?? error}</p>
      ) : null}
      {estimate?.requests ? (
        <details>
          <summary>Estimate assumptions</summary>
          <p>{COST_ASSUMPTIONS}</p>
          <p>
            Output limit: {count(estimate.models[0]?.outputTokenLimit ?? 0)} tokens per request.
          </p>
          <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">
            OpenRouter prices
          </a>
        </details>
      ) : null}
      {!pending ? (
        <button type="button" className="text-button tiny" onClick={refresh}>
          Refresh estimate
        </button>
      ) : null}
    </div>
  );
}
