import {
  type AgentLink,
  dismiss,
  EventPacer,
  type ExtensionUi,
  emptyExtensionUi,
  emptySession,
  follow,
  isDialog,
  type LocalAction,
  note,
  openSession,
  type PiEvent,
  plain,
  present,
  type RpcExtensionUIResponse,
  type RpcSessionState,
  reduce,
  restore,
  type SessionStats,
  type SessionView,
} from "@pituitary/rpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as profile from "./profile.ts";

export interface SessionController {
  view: SessionView;
  /** Session metadata from pi, absent until the first `get_state` reply arrives. */
  state: RpcSessionState | null;
  /** Tokens, cost, and context use, refreshed as replies complete. */
  stats: SessionStats | null;
  /** What extensions show outside the conversation, and the dialogs they wait on. */
  extensionUi: ExtensionUi;
  /** Why the agent can no longer be reached, once it cannot. */
  closed: string | null;
  /**
   * Sends a prompt, a steering or follow-up message while a run is in progress, or a `!`
   * command. Resolves false when pi turns it away, with the reason in the conversation.
   */
  send(text: string, options?: { followUp?: boolean }): Promise<boolean>;
  abort(): void;
  /**
   * Stops the run and sends what was queued, steering first, as the next prompt once pi has
   * settled. Resolves to the queued text pi did not take.
   */
  interrupt(): Promise<string>;
  /** True while a command the operator ran is still running. */
  shellBusy: boolean;
  abortBash(): void;
  abortRetry(): void;
  /** Takes the queued messages back out of pi, as one text for the editor. */
  takeQueue(): Promise<string>;
  /** Answers the dialog `id` and takes it off the screen. */
  answer(id: string, response: RpcExtensionUIResponse): void;
  /**
   * Re-reads pi's state, rebuilding the view when the session moved. `rebuild` rebuilds it
   * regardless, for a move along the tree that keeps the session and its message count.
   */
  refresh(options?: { rebuild?: boolean }): Promise<void>;
  /** Puts a notice in the conversation from this client. */
  notify(level: "info" | "warning" | "error", text: string): void;
  /** How many events and extension requests pi has sent, for telling whether anything happened. */
  activity(): number;
}

/**
 * Streams a pi session into React state.
 *
 * Events are reduced outside React and published once per paced flush, so a fast
 * agent produces one render per frame rather than one per delta.
 *
 * A prompt sent while the agent runs is queued as a steering message, which is what
 * pi requires of any client that lets the operator type during a turn.
 */
export function useSession(link: AgentLink): SessionController {
  const [view, setView] = useState<SessionView>(emptySession);
  const [state, setState] = useState<RpcSessionState | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [extensionUi, setExtensionUi] = useState<ExtensionUi>(emptyExtensionUi);
  const [closed, setClosed] = useState<string | null>(null);
  const reduced = useRef<SessionView>(emptySession);
  /** The session the view was built from, once the first load lands. */
  const built = useRef<string | null>(null);
  const sync = useRef<(rebuild?: boolean) => Promise<void>>(async () => {});
  const dispatch = useRef<(action: LocalAction) => void>(() => {});
  const noticeRef = useRef<(level: "info" | "warning" | "error", text: string) => void>(() => {});
  const commands = useRef(0);
  const heardTotal = useRef(0);

  useEffect(() => {
    let active = true;
    reduced.current = emptySession;
    built.current = null;
    setView(emptySession);
    setState(null);
    setStats(null);
    setExtensionUi(emptyExtensionUi);
    setClosed(null);
    const pacer = new EventPacer({
      apply: (event) => {
        reduced.current = reduce(reduced.current, event);
      },
      onFlush: () => setView(reduced.current),
    });
    dispatch.current = (action) => {
      if (!active) return;
      pacer.flush();
      reduced.current = reduce(reduced.current, action);
      setView(reduced.current);
    };
    const noted = (level: "info" | "warning" | "error", text: string) => {
      if (!active) return;
      pacer.flush();
      reduced.current = note(reduced.current, level, text);
      setView(reduced.current);
    };
    noticeRef.current = noted;
    // pi resolves a timed-out dialog on its own side without telling the client.
    const expiries = new Set<ReturnType<typeof setTimeout>>();
    // The session can change under the view: an extension starts a fresh one, or moves
    // along the tree. What pi holds is then the truth, and the view is rebuilt from it.
    // The counts pi and the view keep can differ for a moment while anything is in
    // progress, so a count alone rebuilds only once everything is still; another
    // session is rebuilt carrying on any run pi has in progress in it.
    // A snapshot holds pi's messages as of its reply and misses any event reduced after
    // it, so a snapshot taken while events arrive is dropped and a later sync rebuilds.
    let heard = 0;
    let syncing: Promise<void> | null = null;
    let again = false;
    let forced = false;
    let statsRead = 0;
    let snapshotEvents: { event: PiEvent; sequence?: number }[] | null = null;
    let snapshotOverflow = false;
    const readStats = () => {
      const read = ++statsRead;
      link.getSessionStats().then(
        (next) => {
          if (active && read === statsRead) setStats(next);
        },
        () => {},
      );
    };
    const once = async () => {
      const rebuild = forced;
      forced = false;
      if (link.getSnapshot) {
        const received: { event: PiEvent; sequence?: number }[] = [];
        snapshotEvents = received;
        snapshotOverflow = false;
        try {
          const snapshot = await link.getSnapshot();
          if (!active) return;
          if (snapshotOverflow) {
            again = true;
            return;
          }
          const first = built.current === null;
          const elsewhere = !first && snapshot.state.sessionId !== built.current;
          pacer.flush();
          if (elsewhere) setExtensionUi(openSession);
          let rebuilt = restore(snapshot.messages, elsewhere ? undefined : reduced.current, snapshot);
          // The atomic snapshot includes every event through its cursor. Replay only
          // later arrivals, including those received before its response was handled.
          for (const receivedEvent of received) {
            if (receivedEvent.sequence === undefined || receivedEvent.sequence > snapshot.sequence) {
              rebuilt = reduce(rebuilt, receivedEvent.event);
            }
          }
          reduced.current = { ...rebuilt, waitingSince: reduced.current.waitingSince };
          built.current = snapshot.state.sessionId;
          setState(snapshot.state);
          setView(reduced.current);
          readStats();
          if (first) {
            profile.mark("state");
            profile.mark("session-loaded");
          }
        } finally {
          snapshotEvents = null;
        }
        return;
      }
      const mark = heard;
      const next = await link.getState();
      if (!active) return;
      setState(next);
      readStats();
      if (built.current === null) return;
      const elsewhere = next.sessionId !== built.current;
      const still =
        !next.isStreaming &&
        !next.isCompacting &&
        !reduced.current.running &&
        !reduced.current.entries.some((entry) => entry.kind === "bash" && entry.running);
      const drifted = still && next.messageCount !== reduced.current.messages;
      if (!elsewhere && !drifted && !rebuild) return;
      const messages = await link.getMessages();
      if (!active) return;
      if (heard !== mark) {
        forced ||= rebuild;
        again = still;
        return;
      }
      pacer.flush();
      if (elsewhere) setExtensionUi(openSession);
      built.current = next.sessionId;
      // The session holds no trace of a dialog, so a rebuild keeps the wait on the operator.
      const rebuilt = {
        ...restore(messages, elsewhere ? undefined : reduced.current),
        waitingSince: reduced.current.waitingSince,
      };
      reduced.current = next.isStreaming
        ? { ...rebuilt, running: true, phase: "streaming", startedAt: Date.now() }
        : rebuilt;
      setView(reduced.current);
    };
    sync.current = async (rebuild = false) => {
      if (!active) return;
      forced ||= rebuild;
      if (syncing) {
        again = true;
        return syncing;
      }
      syncing = (async () => {
        try {
          do {
            again = false;
            await once();
          } while (active && again);
        } catch (cause) {
          noted("error", describe(cause));
        } finally {
          syncing = null;
        }
      })();
      return syncing;
    };
    // Usage changes as each reply completes; a burst of them costs one request.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const refreshStats = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        readStats();
      }, 250);
    };
    const unsubscribeEvents = link.onEvent((event, sequence) => {
      heard++;
      heardTotal.current++;
      if (snapshotEvents) {
        if (snapshotEvents.length < 2048) snapshotEvents.push({ event, sequence });
        else snapshotOverflow = true;
      }
      pacer.handle(event);
      if (event.type === "agent_start" || event.type === "agent_settled") {
        setExtensionUi((current) => follow(current, event));
      }
      if (event.type === "agent_settled" || event.type === "session_info_changed") void sync.current();
      if (event.type === "message_end" || event.type === "compaction_end" || event.type === "agent_settled") {
        refreshStats();
      }
    });
    const unsubscribeUi = link.onUiRequest((request) => {
      heardTotal.current++;
      if (request.method === "notify") {
        noted(request.notifyType ?? "info", plain(request.message));
        return;
      }
      setExtensionUi((current) => present(current, request));
      if (isDialog(request) && "timeout" in request && request.timeout) {
        const expiry = setTimeout(() => {
          expiries.delete(expiry);
          setExtensionUi((current) => dismiss(current, request.id));
        }, request.timeout);
        expiries.add(expiry);
      }
    });
    const unsubscribeUiClose = link.onUiClose?.((id) => {
      setExtensionUi((current) => dismiss(current, id));
    });
    const unsubscribeClose = link.onClose((reason) => {
      setClosed(reason);
      setExtensionUi((current) => ({ ...current, dialogs: [] }));
      dispatch.current({ type: "closed" });
      noted("error", `pi stopped: ${reason}`);
    });
    const mark = heard;
    const firstState = !link.getSnapshot
      ? link.getState().then((first) => {
          profile.mark("state");
          return first;
        })
      : null;
    if (firstState)
      Promise.all([firstState, link.getMessages()])
        .then(([first, messages]) => {
          if (!active) return;
          profile.mark("session-loaded");
          built.current = first.sessionId;
          setState(first);
          readStats();
          if (messages.length === 0 || heard !== mark) return;
          pacer.flush();
          reduced.current = { ...restore(messages), waitingSince: reduced.current.waitingSince };
          setView(reduced.current);
        })
        .catch((cause: unknown) => noted("error", describe(cause)));
    else void sync.current(true);
    return () => {
      active = false;
      unsubscribeEvents();
      unsubscribeUi();
      unsubscribeUiClose?.();
      unsubscribeClose();
      for (const expiry of expiries) clearTimeout(expiry);
      if (pending) clearTimeout(pending);
      pacer.dispose();
    };
  }, [link]);

  const send = useCallback(
    async (text: string, options: { followUp?: boolean } = {}): Promise<boolean> => {
      const message = text.trim();
      if (message.length === 0) return true;
      // Completions of this request belong to this mount, even if the link changes meanwhile.
      const apply = dispatch.current;
      const notify = noticeRef.current;
      const resync = sync.current;
      if (message.startsWith("!")) {
        const excluded = message.startsWith("!!");
        const command = message.slice(excluded ? 2 : 1).trim();
        if (!command) return true;
        const request = `bash-${++commands.current}`;
        apply({ type: "bash_start", request, command, excluded });
        link
          .bash(request, command, excluded)
          .then((result) => apply({ type: "bash_end", request, result }))
          .catch((cause: unknown) => {
            apply({
              type: "bash_end",
              request,
              result: { output: describe(cause), cancelled: true, truncated: false },
            });
          });
        return true;
      }
      // pi reads the streaming behaviour only while it is running, so it always goes: the
      // view learns a run has begun a moment after pi does.
      try {
        await link.prompt(message, options.followUp ? "followUp" : "steer");
      } catch (cause) {
        notify("error", describe(cause));
        return false;
      }
      // An extension command answers once its handler is done, which may have moved the session.
      if (message.startsWith("/")) await resync();
      return true;
    },
    [link],
  );

  const abort = useCallback(() => {
    const notify = noticeRef.current;
    link.abort().catch((cause: unknown) => notify("error", describe(cause)));
  }, [link]);

  const interrupt = useCallback(async () => {
    const notify = noticeRef.current;
    // Taken ahead of the abort: pi's loop hands queued steering to a run that stops mid-tool.
    const [taken, stopped] = await Promise.allSettled([link.clearQueue(), link.abort()]);
    for (const result of [taken, stopped]) {
      if (result.status === "rejected") notify("error", describe(result.reason));
    }
    if (taken.status === "rejected") return "";
    const queued = [...taken.value.steering, ...taken.value.followUp].join("\n\n");
    // pi answers an abort once the run has settled, so the prompt starts a run of its own.
    if (!queued || stopped.status === "rejected") return queued;
    try {
      await link.prompt(queued);
      return "";
    } catch (cause) {
      notify("error", describe(cause));
      return queued;
    }
  }, [link]);

  const shellBusy = view.entries.some((entry) => entry.kind === "bash" && entry.running);

  const waiting = extensionUi.dialogs.length > 0;
  useEffect(() => dispatch.current({ type: "waiting", waiting }), [waiting]);

  const abortRetry = useCallback(() => {
    const notify = noticeRef.current;
    link.abortRetry().catch((cause: unknown) => notify("error", describe(cause)));
  }, [link]);

  const abortBash = useCallback(() => {
    const notify = noticeRef.current;
    link.abortBash().catch((cause: unknown) => notify("error", describe(cause)));
  }, [link]);

  const takeQueue = useCallback(async () => {
    if (closed) {
      const { steering, followUp } = reduced.current.queue;
      dispatch.current({ type: "queue_taken" });
      return [...steering, ...followUp].join("\n\n");
    }
    const notify = noticeRef.current;
    try {
      const { steering, followUp } = await link.clearQueue();
      return [...steering, ...followUp].join("\n\n");
    } catch (cause) {
      notify("error", `could not take back queued messages: ${describe(cause)}`);
      return "";
    }
  }, [link, closed]);

  const refresh = useCallback((options?: { rebuild?: boolean }) => sync.current(options?.rebuild), []);
  const notify = useCallback(
    (level: "info" | "warning" | "error", text: string) => noticeRef.current(level, text),
    [],
  );

  const activity = useCallback(() => heardTotal.current, []);

  const answer = useCallback(
    (id: string, response: RpcExtensionUIResponse) => {
      link.respond(response);
      setExtensionUi((current) => dismiss(current, id));
    },
    [link],
  );

  return useMemo(
    () => ({
      view,
      state,
      stats,
      extensionUi,
      closed,
      send,
      abort,
      interrupt,
      shellBusy,
      abortBash,
      abortRetry,
      takeQueue,
      answer,
      refresh,
      notify,
      activity,
    }),
    [
      view,
      state,
      stats,
      extensionUi,
      closed,
      send,
      abort,
      interrupt,
      shellBusy,
      abortBash,
      abortRetry,
      takeQueue,
      answer,
      refresh,
      notify,
      activity,
    ],
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
