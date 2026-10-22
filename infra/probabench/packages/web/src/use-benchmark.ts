import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLocalStatus, type LocalStatus, postJob } from "./benchmark";

export interface Bridge {
  readonly mode: "checking" | "local" | "published";
  readonly status: LocalStatus | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly start: (options: Parameters<typeof postJob>[1]) => Promise<boolean>;
  readonly cancel: () => Promise<boolean>;
}

export function useBenchmarkBridge(onCompleted: () => void): Bridge {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [mode, setMode] = useState<Bridge["mode"]>("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const completed = useRef<string | null>(null);
  const hadLocal = useRef(false);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    if (revision > 0) setError(null);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = async () => {
      const next = await fetchLocalStatus();
      if (!alive) return;
      if (!next && hadLocal.current) {
        // Keep the running job reachable through a temporary network interruption.
        setConnectionError("The local runner is temporarily unreachable. Reconnecting…");
        timer = setTimeout(() => {
          void update();
        }, 1500);
        return;
      }
      setStatus(next);
      setMode(next ? "local" : "published");
      setConnectionError(null);
      if (next) hadLocal.current = true;
      if (next?.job && next.job.status !== "running" && completed.current !== next.job.id) {
        completed.current = next.job.id;
        onCompletedRef.current();
      }
      if (next)
        timer = setTimeout(
          () => {
            void update();
          },
          next.job?.status === "running" ? 1200 : 6000,
        );
    };
    void update();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const act = async (path: "run" | "cancel", options?: Parameters<typeof postJob>[1]) => {
    setPending(true);
    setError(null);
    try {
      const job = await postJob(path, options);
      setStatus((previous) => (previous ? { ...previous, job } : null));
      refresh();
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The local runner is unavailable. Try again.",
      );
      return false;
    } finally {
      setPending(false);
    }
  };

  return {
    mode,
    status,
    pending,
    error: error ?? connectionError,
    refresh,
    start: (options) => act("run", options),
    cancel: () => act("cancel"),
  };
}
