import type { Connection } from "../bridge/use-bridge";

export function SiteHeader({
  connection,
  onOpenSetup,
}: {
  connection: Connection;
  /** Absent on the published site, which cannot run benchmarks. */
  onOpenSetup: (() => void) | undefined;
}) {
  const running = connection.kind === "local" && connection.status.job?.status === "running";
  return (
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
        {onOpenSetup ? (
          <button type="button" className="button primary" onClick={onOpenSetup}>
            {running ? "View progress" : "New benchmark"}
            <span aria-hidden="true">↗</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
