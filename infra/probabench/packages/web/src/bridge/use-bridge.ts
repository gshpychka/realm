import { useCallback, useEffect, useRef, useState } from "react";
import { cancelRun, fetchStatus, startRun } from "./client";
import type { BenchRequest, BridgeStatus } from "./protocol";

export type Connection =
  /** A production build: there is no dev bridge, so the page is read-only. */
  | { readonly kind: "published" }
  /** The dev server, before its first status arrives. */
  | { readonly kind: "connecting" }
  /** The dev bridge's latest status; `reconnecting` while it stops answering. */
  | { readonly kind: "local"; readonly status: BridgeStatus; readonly reconnecting: boolean };

export const POLL_MS = { running: 1_200, idle: 6_000, retry: 1_500 } as const;

/** A failed poll keeps the last status, so a running job stays visible while the bridge is away. */
export const nextConnection = (previous: Connection, status: BridgeStatus | null): Connection =>
  status !== null
    ? { kind: "local", status, reconnecting: false }
    : previous.kind === "local"
      ? { ...previous, reconnecting: true }
      : previous;

/** Milliseconds until the next poll, or null when there is nothing to poll. */
export const nextDelay = (connection: Connection): number | null => {
  switch (connection.kind) {
    case "published":
      return null;
    case "connecting":
      return POLL_MS.retry;
    case "local":
      if (connection.reconnecting) return POLL_MS.retry;
      return connection.status.job?.status === "running" ? POLL_MS.running : POLL_MS.idle;
  }
};

// The plugin applies only to `vite serve`, so only the dev server has a bridge to ask.
const INITIAL: Connection = import.meta.env.DEV ? { kind: "connecting" } : { kind: "published" };

export interface Bridge {
  readonly connection: Connection;
  readonly pending: boolean;
  readonly error: string | null;
  readonly start: (request: BenchRequest) => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
}

export function useBridge(onJobFinished: () => void): Bridge {
  const [connection, setConnection] = useState(INITIAL);
  // The poll loop reads this rather than its closure's stale state.
  const latest = useRef(INITIAL);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const finishedJobId = useRef<string | null>(null);
  const onJobFinishedRef = useRef(onJobFinished);
  onJobFinishedRef.current = onJobFinished;

  const apply = useCallback((status: BridgeStatus | null): Connection => {
    const next = nextConnection(latest.current, status);
    latest.current = next;
    setConnection(next);
    const job = status?.job;
    if (job && job.status !== "running" && job.id !== finishedJobId.current) {
      finishedJobId.current = job.id;
      onJobFinishedRef.current();
    }
    return next;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision restarts polling at once.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const status = await fetchStatus();
      if (!alive) return;
      const delay = nextDelay(apply(status));
      if (delay !== null) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [apply, revision]);

  const act = async (action: () => Promise<BridgeStatus>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      apply(await action());
      // Poll again now, at the cadence the new status calls for.
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setPending(false);
    }
  };

  return {
    connection,
    pending,
    error,
    start: (request) => act(() => startRun(request)),
    cancel: () => act(cancelRun),
  };
}
