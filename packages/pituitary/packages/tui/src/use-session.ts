import {
  type ConversationLink,
  EventPacer,
  emptySession,
  note,
  reduce,
  restore,
  type SessionEvent,
  type SessionState,
  type SessionStats,
  type SessionView,
} from "@pituitary/session";
import { useCallback, useEffect, useRef, useState } from "react";
import * as profile from "./profile.ts";

export interface SessionController {
  view: SessionView;
  state: SessionState | null;
  stats: SessionStats | null;
  closed: string | null;
  send(text: string, options?: { followUp?: boolean }): Promise<boolean>;
  abort(): void;
  interrupt(): Promise<string>;
  abortRetry(): void;
  takeQueue(): Promise<string>;
  refresh(): Promise<void>;
  notify(level: "info" | "warning" | "error", text: string): void;
}

/** Native snapshots establish a cursor; only later events are replayed over them. */
export function useSession(link: ConversationLink): SessionController {
  const [view, setView] = useState<SessionView>(emptySession);
  const [state, setState] = useState<SessionState | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const reduced = useRef(emptySession);
  const generation = useRef(0);
  const sync = useRef<() => Promise<void>>(async () => {});
  const notice = useRef<(level: "info" | "warning" | "error", text: string) => void>(() => {});
  useEffect(() => {
    let active = true;
    generation.current++;
    let syncing: Promise<void> | null = null;
    let again = false;
    let first = true;
    let received: { event: SessionEvent; sequence: number }[] | null = null;
    let overflow = false;
    let statsRead = 0;
    let statsTimer: ReturnType<typeof setTimeout> | undefined;
    reduced.current = emptySession;
    setView(emptySession);
    setState(null);
    setStats(null);
    setClosed(null);
    const pacer = new EventPacer({
      apply: (event) => {
        reduced.current = reduce(reduced.current, event);
      },
      onFlush: () => setView(reduced.current),
    });
    notice.current = (level, text) => {
      if (!active) return;
      pacer.flush();
      reduced.current = note(reduced.current, level, text, true);
      setView(reduced.current);
    };
    const readStats = () => {
      const id = ++statsRead;
      void link.getSessionStats().then(
        (value) => {
          if (active && id === statsRead) setStats(value);
        },
        () => {},
      );
    };
    sync.current = async () => {
      if (!active) return;
      if (syncing) {
        again = true;
        return syncing;
      }
      syncing = (async () => {
        do {
          again = false;
          const events: { event: SessionEvent; sequence: number }[] = [];
          received = events;
          overflow = false;
          try {
            const snapshot = await link.getSnapshot();
            if (!active) return;
            if (overflow) {
              again = true;
              continue;
            }
            pacer.flush();
            let next = restore(snapshot.messages, reduced.current, snapshot);
            for (const item of events) if (item.sequence > snapshot.sequence) next = reduce(next, item.event);
            reduced.current = next;
            setView(next);
            setState(snapshot.state);
            readStats();
            if (first) {
              first = false;
              profile.mark("state");
              profile.mark("session-loaded");
            }
          } finally {
            received = null;
          }
        } while (active && again);
      })()
        .catch((error) => notice.current("error", describe(error)))
        .finally(() => {
          syncing = null;
        });
      return syncing;
    };
    const offEvents = link.onEvent((event, sequence) => {
      if (received) {
        if (received.length < 2048) received.push({ event, sequence });
        else overflow = true;
      }
      pacer.handle(event);
      if (event.type === "agent_settled" || event.type === "session_info_changed") void sync.current();
      if (event.type === "message_end" || event.type === "compaction_end") {
        if (!statsTimer)
          statsTimer = setTimeout(() => {
            statsTimer = undefined;
            readStats();
          }, 250);
      }
    });
    const offClose = link.onClose((reason) => {
      setClosed(reason);
      pacer.flush();
      reduced.current = reduce(reduced.current, { type: "closed" });
      setView(reduced.current);
      notice.current("error", `Conversation disconnected: ${reason}`);
    });
    void sync.current();
    return () => {
      active = false;
      offEvents();
      offClose();
      if (statsTimer) clearTimeout(statsTimer);
      pacer.dispose();
    };
  }, [link]);
  const notify = useCallback(
    (level: "info" | "warning" | "error", text: string) => notice.current(level, text),
    [],
  );
  const send = useCallback(
    async (text: string, options: { followUp?: boolean } = {}) => {
      if (!text.trim()) return true;
      const own = generation.current;
      try {
        await link.prompt(text, options.followUp ? "followUp" : "steer");
        return true;
      } catch (error) {
        if (own === generation.current) notify("error", describe(error));
        return false;
      }
    },
    [link, notify],
  );
  const abort = useCallback(() => {
    const own = generation.current;
    void link.abort().catch((error) => {
      if (own === generation.current) notify("error", describe(error));
    });
  }, [link, notify]);
  const abortRetry = useCallback(() => {
    const own = generation.current;
    void link.abortRetry().catch((error) => {
      if (own === generation.current) notify("error", describe(error));
    });
  }, [link, notify]);
  const takeQueue = useCallback(async () => {
    const own = generation.current;
    if (closed) {
      const text = [...reduced.current.queue.steering, ...reduced.current.queue.followUp].join("\n\n");
      reduced.current = reduce(reduced.current, { type: "queue_taken" });
      setView(reduced.current);
      return text;
    }
    try {
      const value = await link.clearQueue();
      await sync.current();
      return [...value.steering, ...value.followUp].join("\n\n");
    } catch (error) {
      if (own === generation.current) notify("error", describe(error));
      return "";
    }
  }, [link, closed, notify]);
  const interrupt = useCallback(async () => {
    const own = generation.current;
    const taken = await takeQueue();
    if (own !== generation.current) return taken;
    try {
      await link.abort();
      if (taken) await link.prompt(taken);
      return "";
    } catch (error) {
      if (own === generation.current) notify("error", describe(error));
      return taken;
    }
  }, [link, takeQueue, notify]);
  const refresh = useCallback(() => sync.current(), []);
  return { view, state, stats, closed, send, abort, interrupt, abortRetry, takeQueue, refresh, notify };
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
