import type { Connection } from "../bridge/use-bridge";

const CONNECTION_LABEL = {
  published: "Published notebook",
  connecting: "Connecting",
  local: "Local workspace",
} as const satisfies Record<Connection["kind"], string>;

export function SiteHeader({
  connection,
  onOpenSetup,
}: {
  connection: Connection;
  onOpenSetup: () => void;
}) {
  const local = connection.kind === "local" ? connection.status : null;
  const running = local?.job?.status === "running";
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
        {running ? (
          <button type="button" className="connection running" onClick={onOpenSetup}>
            <span className="status-dot pulse" />
            Benchmark running
          </button>
        ) : (
          <span className="connection">
            <span className={`status-dot ${local?.configured ? "ready" : ""}`} />
            {CONNECTION_LABEL[connection.kind]}
          </span>
        )}
        <button type="button" className="button primary" onClick={onOpenSetup}>
          {running ? "View progress" : "New benchmark"}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </header>
  );
}
