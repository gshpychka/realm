import {
  type ConversationLink,
  EventPacer,
  emptySession,
  type ImageContent,
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
  send(text: string, options?: { followUp?: boolean; images?: ImageContent[] }): Promise<boolean>;
  abort(): void;
  interrupt(): Promise<string>;
  abortRetry(): void;
  takeQueue(): Promise<string>;
  refresh(): Promise<void>;
  /** Notes `text` in the conversation; `file` names a file it is about, drawn as a link. */
  notify(level: "info" | "warning" | "error", text: string, file?: string): void;
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
  const notice = useRef<SessionController["notify"]>(() => {});
  useEffect(() => {
    let active = true;
    generation.current++;
    let syncing: Promise<void> | null = null;
    let again = false;
    let first = true;
    let received: { event: SessionEvent; sequence: number }[] | null = null;
    let overflow = false;
    // Bumped when the link moves to another session, so a snapshot read before then is discarded.
    let replacements = 0;
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
    notice.current = (level, text, file) => {
      if (!active) return;
      pacer.flush();
      reduced.current = note(reduced.current, level, text, true, file);
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
          const replaced = replacements;
          try {
            const snapshot = await link.getSnapshot();
            if (!active) return;
            if (overflow || replaced !== replacements) {
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
      if (
        event.type === "agent_settled" ||
        event.type === "session_info_changed" ||
        event.type === "thinking_level_changed" ||
        // Pi records a shell command as it ends, unless a run is under way: it waits for the run's
        // end then. It records nothing of a command it could not run.
        (event.type === "bash_end" && event.result !== undefined && !reduced.current.running)
      )
        void sync.current();
      if (event.type === "message_end" || event.type === "compaction_end") {
        if (!statsTimer)
          statsTimer = setTimeout(() => {
            statsTimer = undefined;
            readStats();
          }, 250);
      }
    });
    // Nothing the previous session showed belongs to the next one, local notices included;
    // what is noted from here on follows the next session's messages.
    const offReplace = link.onReplace?.(() => {
      replacements++;
      generation.current++;
      pacer.flush();
      reduced.current = emptySession;
      setView(emptySession);
      void sync.current();
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
      offReplace?.();
      offClose();
      if (statsTimer) clearTimeout(statsTimer);
      pacer.dispose();
    };
  }, [link]);
  const notify = useCallback<SessionController["notify"]>(
    (level, text, file) => notice.current(level, text, file),
    [],
  );
  const send = useCallback(
    async (text: string, options: { followUp?: boolean; images?: ImageContent[] } = {}) => {
      if (!text.trim()) return true;
      const own = generation.current;
      try {
        await link.prompt(text, options.followUp ? "followUp" : "steer", options.images);
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
