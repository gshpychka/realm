import type { Connection } from "../bridge/use-bridge";

const CONNECTION_LABEL = {
  published: "Published notebook",
  connecting: "Connecting",
  local: "Local workspace",
} as const satisfies Record<Connection["kind"], string>;

/** The label and status-dot modifier of the connection's most pressing state. */
const connectionStatus = (connection: Connection, running: boolean) => {
  if (connection.kind !== "local") return { label: CONNECTION_LABEL[connection.kind], dot: "" };
  if (connection.reconnecting) return { label: "Reconnecting", dot: "" };
  if (running) return { label: "Benchmark running", dot: "pulse" };
  return { label: CONNECTION_LABEL.local, dot: connection.status.configured ? "ready" : "" };
};

export function SiteHeader({
  connection,
  onOpenSetup,
}: {
  connection: Connection;
  /** Absent on the published site, which cannot run benchmarks. */
  onOpenSetup: (() => void) | undefined;
}) {
  const running = connection.kind === "local" && connection.status.job?.status === "running";
  const status = connectionStatus(connection, running);
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
        <span className="connection">
          <span className={`status-dot ${status.dot}`} />
          {status.label}
        </span>
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
