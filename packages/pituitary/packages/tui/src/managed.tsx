import type { ConversationClient } from "@pituitary/harness/conversation";
import type { RunDetail, Runtime } from "@pituitary/harness/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "./app.tsx";
import type { ConversationState, TeamContext } from "./components/team.tsx";
import type { ManagedView } from "./ui-state.ts";

type TeamRuntime = Pick<Runtime, "inspect" | "connect"> & {
  answer(questionId: string, answer: string): Promise<unknown>;
  retry(taskId: string, revision: number): Promise<unknown>;
  revise(taskId: string, revision: number, input: { objective: string }): Promise<unknown>;
  integrate(taskId: string, revision: number): Promise<unknown>;
  apply(runId: string): Promise<unknown>;
};

interface Attached {
  client: ConversationClient;
  taskId: string;
  attemptId: string;
  serial: number;
}

/** One visible conversation, with the team's durable state beside it. */
export function ManagedWorkspace({
  runtime,
  initial,
  taskId,
  client,
  saved,
  onClient,
  onCapture,
  onQuit,
  onReload,
}: {
  runtime: TeamRuntime;
  initial: RunDetail;
  taskId: string;
  client: ConversationClient;
  saved?: ManagedView;
  onClient(client: ConversationClient): void;
  onCapture(capture: () => ManagedView): void;
  onQuit(): void;
  onReload(): void;
}) {
  const [detail, setDetail] = useState(initial);
  const [attached, setAttached] = useState<Attached>({
    client,
    taskId,
    attemptId: initial.tasks.find((task) => task.id === taskId)?.currentAttemptId ?? taskId,
    serial: 0,
  });
  const active = useRef(attached);
  active.current = attached;
  const latest = useRef(detail);
  latest.current = detail;
  const views = useRef({ ...saved?.views });
  const history = useRef<{ taskId: string; control: boolean }[]>([]);
  const captureConversation = useRef<(() => ConversationState) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const opening = useRef(false);
  const openingRequest = useRef<AbortController | null>(null);

  const save = useCallback((view?: ConversationState) => {
    const current = view ?? captureConversation.current?.();
    if (current) views.current[active.current.attemptId] = current;
  }, []);
  useEffect(() => {
    onCapture(() => {
      save();
      return {
        taskId: active.current.taskId,
        control: active.current.client.controlsInput,
        views: views.current,
      };
    });
  }, [onCapture, save]);

  const open = useCallback(
    async (id: string, control = false, view?: ConversationState, back = false) => {
      save(view);
      const previous = active.current;
      const ticket = ++generation.current;
      openingRequest.current?.abort();
      const controller = new AbortController();
      openingRequest.current = controller;
      opening.current = true;
      setBusy(control ? "Joining conversation…" : "Opening conversation…");
      setError(null);
      // Joining releases our observer connection before requesting the conversation's input lease.
      if (control && previous.taskId === id) await previous.client.close();
      try {
        const next = await runtime.connect(initial.run.id, control, id, controller.signal);
        if (!alive.current || ticket !== generation.current) {
          await next.close();
          return;
        }
        if (!back && previous.taskId !== id)
          history.current.push({ taskId: previous.taskId, control: previous.client.controlsInput });
        captureConversation.current = null;
        onClient(next);
        setAttached({
          client: next,
          taskId: id,
          attemptId: next.identity.attemptId,
          serial: previous.serial + 1,
        });
        if (next !== previous.client) await previous.client.close();
      } catch (cause) {
        if (ticket !== generation.current || !alive.current) return;
        setError(String(cause));
        if (control && previous.taskId === id) {
          // A denied lease leaves a useful observer instead of a disconnected conversation.
          try {
            const observer = await runtime.connect(initial.run.id, false, id);
            if (!alive.current || ticket !== generation.current) {
              await observer.close();
              return;
            }
            onClient(observer);
            setAttached({ ...previous, client: observer, serial: previous.serial + 1 });
          } catch {
            /* The saved transcript remains visible until a later reconnect. */
          }
        }
      } finally {
        if (ticket === generation.current && alive.current) {
          opening.current = false;
          setBusy(null);
        }
      }
    },
    [initial.run.id, onClient, runtime, save],
  );

  const refresh = useCallback(async () => {
    const next = await runtime.inspect(initial.run.id);
    if (!alive.current) return;
    setDetail((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    const current = active.current;
    const task = next.tasks.find((task) => task.id === current.taskId);
    const attempt = next.attempts.find((attempt) => attempt.id === task?.currentAttemptId);
    const archived =
      attempt &&
      (attempt.desired !== "running" ||
        next.run.desired !== "running" ||
        Boolean(task && !["queued", "running", "waiting"].includes(task.status)));
    if (
      !opening.current &&
      task?.currentAttemptId &&
      (task.currentAttemptId !== current.attemptId || (archived && !current.client.identity.archived))
    ) {
      latest.current = next;
      void open(task.id);
    }
  }, [initial.run.id, open, runtime]);
  useEffect(() => {
    alive.current = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void refresh()
        .catch((cause) => {
          if (alive.current) setError(String(cause));
        })
        .finally(() => {
          pending = false;
        });
    }, 1200);
    return () => {
      alive.current = false;
      generation.current++;
      openingRequest.current?.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  const action = async (label: string, operation: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(String(cause));
      throw cause;
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  const context: TeamContext = {
    detail,
    taskId: attached.taskId,
    busy,
    error,
    canBack:
      history.current.length > 0 ||
      Boolean(detail.tasks.find((task) => task.id === attached.taskId)?.parentTaskId),
    select: (id, view) => {
      if (id !== attached.taskId) void open(id, false, view);
    },
    back: (view) => {
      const previous = history.current.pop();
      if (previous) void open(previous.taskId, previous.control, view, true);
      else {
        const parent = latest.current.tasks.find((task) => task.id === attached.taskId)?.parentTaskId;
        if (parent) void open(parent, false, view, true);
      }
    },
    join: (view) => {
      if (attached.client.identity.archived || attached.client.controlsInput) return;
      void open(attached.taskId, true, view);
    },
    answer: (id, answer) => action("Sending your answer…", () => runtime.answer(id, answer)),
    retry: (task) => action("Starting a fresh attempt…", () => runtime.retry(task.id, task.revision)),
    revise: (task, objective) =>
      action("Saving a new revision…", () => runtime.revise(task.id, task.revision, { objective })),
    integrate: (task) =>
      action("Integrating retained code…", () => runtime.integrate(task.id, task.revision)),
    apply: () => action("Applying verified code…", () => runtime.apply(initial.run.id)),
  };
  const task = detail.tasks.find((task) => task.id === attached.taskId);
  const archived = attached.client.identity.archived === true;
  return (
    <App
      key={`${attached.attemptId}:${attached.serial}`}
      link={attached.client}
      team={context}
      initialView={views.current[attached.attemptId]}
      onCaptureView={(capture) => {
        captureConversation.current = capture;
      }}
      workspace={{
        cwd: attached.client.identity.cwd,
        local: attached.client.identity.local && process.env.PITUITARY_REMOTE_UI !== "1" && !archived,
        modelSelectable:
          attached.client.identity.local &&
          !attached.client.identity.role &&
          !archived &&
          attached.client.controlsInput,
        access: archived ? "archive" : attached.client.controlsInput ? "control" : "observe",
        label: [task?.role ?? "solo", archived ? "archived" : undefined].filter(Boolean).join(" · "),
      }}
      onQuit={onQuit}
      onReload={onReload}
    />
  );
}
