import { useEffect, useRef, useState } from "react";
import type { Job } from "../bridge/protocol";
import type { Bridge } from "../bridge/use-bridge";
import { JobProgress } from "./JobProgress";
import { SetupForm } from "./SetupForm";
import { DEFAULT_SETTINGS } from "./settings";
import "./setup.css";

const heading = (job: Job | null): string => {
  if (job === null) return "Set up a benchmark.";
  return job.status === "running" ? "Benchmark in progress." : "Benchmark update.";
};

/**
 * The benchmark dialog: the latest job while it runs or until it is set aside, else the
 * setup form.
 */
export function RunSetup({
  open,
  onClose,
  onViewResults,
  bridge,
  modelSuggestions,
}: {
  open: boolean;
  onClose: () => void;
  onViewResults: () => void;
  bridge: Bridge;
  modelSuggestions: readonly string[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const latest = bridge.connection.kind === "local" ? bridge.connection.status.job : null;
  // Kept here rather than in SetupForm, so viewing a job and coming back keeps the edits.
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [setAsideJobId, setSetAsideJobId] = useState<string | null>(null);
  const job =
    latest && (latest.status === "running" || latest.id !== setAsideJobId) ? latest : null;
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the native dialog, the keyboard equivalent of clicking its backdrop.
    <dialog
      ref={dialog}
      className="run-dialog"
      aria-labelledby="setup-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-content">
        <header className="dialog-heading">
          <div>
            <p className="eyebrow">{job ? "Your run" : "A new run"}</p>
            <h2 id="setup-title">{heading(job)}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close benchmark setup"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {job ? (
          <JobProgress
            key={job.id}
            job={job}
            bridge={bridge}
            onViewResults={() => {
              // Close first: while the modal is open the rest of the page is inert, so focus
              // that onViewResults moves would not land.
              dialog.current?.close();
              onViewResults();
            }}
            onSetUpAnother={() => setSetAsideJobId(job.id)}
            onClose={onClose}
          />
        ) : (
          <SetupForm
            settings={settings}
            onChange={(patch) => setSettings((value) => ({ ...value, ...patch }))}
            bridge={bridge}
            modelSuggestions={modelSuggestions}
          />
        )}
      </div>
    </dialog>
  );
}
