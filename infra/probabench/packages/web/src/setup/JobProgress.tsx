import { useEffect, useRef, useState } from "react";
import type { Job } from "../bridge/protocol";
import type { Bridge } from "../bridge/use-bridge";
import { time } from "../common/format";
import { FormError } from "./FormError";

const UNSAVED = "An unfinished run is not saved. Earlier runs remain in history.";

const OUTCOME = {
  completed: {
    title: "Run saved to history",
    detail: "Earlier runs remain in history.",
  },
  cancelled: { title: "Run cancelled", detail: UNSAVED },
  failed: { title: "Run stopped", detail: UNSAVED },
} as const satisfies Record<Exclude<Job["status"], "running">, { title: string; detail: string }>;

const describe = (job: Job, cancelling: boolean) => {
  if (job.status !== "running") return OUTCOME[job.status];
  return {
    title: cancelling ? "Stopping the benchmark…" : "Sampling in progress",
    detail: job.progress
      ? `${job.progress.completed} of ${job.progress.total} probability targets sampled.`
      : "Preparing the model and sampling plan.",
  };
};

/** One job's progress, keyed by job id so a new job starts from fresh state. */
export function JobProgress({
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
  // Only read while the job runs, so a finished job never shows a stale value.
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const running = job.status === "running";
  const reconnecting = bridge.connection.kind === "local" && bridge.connection.reconnecting;
  const { title, detail } = describe(job, cancelling);
  useEffect(() => {
    if (job.log && follow.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [job.log]);
  const cancel = async () => {
    setCancelling(true);
    const error = await bridge.cancel();
    setCancelError(error);
    setCancelling(error === null);
  };
  return (
    <section className="job-progress" aria-label="Benchmark progress">
      <div className="job-status" role="status">
        <span className={`status-dot ${running ? "pulse" : ""}`} />
        <strong>{title}</strong>
        <p>{detail}</p>
        <span className="muted">Started {time(job.startedAt)} UTC</span>
        {reconnecting ? (
          <span className="muted">The dev bridge is not answering. Reconnecting…</span>
        ) : null}
      </div>
      {running ? (
        <progress
          aria-label="Probability targets sampled"
          value={job.progress?.completed}
          max={job.progress?.total ?? 1}
        />
      ) : null}
      <FormError message={job.error} />
      <FormError message={cancelError} />
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
            <button type="button" className="button primary" onClick={onViewResults}>
              View results <span aria-hidden="true">↗</span>
            </button>
            <button type="button" className="text-button" onClick={onSetUpAnother}>
              Set up another
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
