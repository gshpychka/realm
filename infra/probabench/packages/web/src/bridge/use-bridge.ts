import { useEffect, useState } from "react";
import { cancelRun, fetchStatus, startRun } from "./client";
import type { BenchRequest, BridgeStatus } from "./protocol";

export type Connection =
  /** A production build: there is no dev bridge, so the page is read-only. */
  | { readonly kind: "published" }
  /** The dev server, before its first status arrives. */
  | { readonly kind: "connecting" }
  /** The dev bridge's latest status; `reconnecting` while it stops answering. */
  | { readonly kind: "local"; readonly status: BridgeStatus; readonly reconnecting: boolean };

/** How often the page asks the dev bridge for its status. */
const POLL_MS = 1_000;

/** A failed poll keeps the last status, so a running job stays visible while the bridge is away. */
export const nextConnection = (previous: Connection, status: BridgeStatus | null): Connection =>
  status !== null
    ? { kind: "local", status, reconnecting: false }
    : previous.kind === "local"
      ? { ...previous, reconnecting: true }
      : previous;

// The plugin applies only to `vite serve`, so only the dev server has a bridge to ask.
const INITIAL: Connection = import.meta.env.DEV ? { kind: "connecting" } : { kind: "published" };

export interface Bridge {
  readonly connection: Connection;
  readonly pending: boolean;
  readonly error: string | null;
  readonly start: (request: BenchRequest) => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
}

export function useBridge(): Bridge {
  const [connection, setConnection] = useState(INITIAL);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const status = await fetchStatus();
      if (!alive) return;
      setConnection((previous) => nextConnection(previous, status));
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const act = async (action: () => Promise<BridgeStatus>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const status = await action();
      setConnection((previous) => nextConnection(previous, status));
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
