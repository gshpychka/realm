import type { BoxRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { usePaste, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import { type ConversationLink, type DialogRequest, plain } from "@pituitary/session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILTINS, builtin } from "./commands/commands.ts";
import { runCommand } from "./commands/run-command.ts";
import { Conversation, type Display } from "./components/conversation.tsx";
import { Editor, type EditorHandle } from "./components/editor.tsx";
import { Footer } from "./components/footer.tsx";
import { type Burn, Mascot, MascotProvider, MascotStage } from "./components/mascot.tsx";
import type { PickerSpec } from "./components/picker.tsx";
import { Popups } from "./components/popups.tsx";
import { Queue } from "./components/queue.tsx";
import {
  type ConversationState,
  TaskResult,
  TeamCards,
  type TeamContext,
  TeamHeader,
  type TeamQuestion,
  type TeamTask,
  taskState,
} from "./components/team.tsx";
import { statusUp, Working } from "./components/working.tsx";
import { editExternally } from "./external-editor.ts";
import { firelight } from "./firelight.ts";
import { usePullRequest } from "./github/use-pull-request.ts";
import { type Action, actionFor, type Keymap, loadKeymap } from "./keymap.ts";
import { KeymapProvider, keyHint } from "./keymap-context.tsx";
import { modelTitle } from "./model-names.ts";
import { remains } from "./remains.ts";
import { theme } from "./theme.ts";
import { worked } from "./transcript.ts";
import { useBranch } from "./use-branch.ts";
import { useCompletion } from "./use-completion.ts";
import { useFlash } from "./use-flash.ts";
import { useHeldKeys } from "./use-held-keys.ts";
import { type Offer, useOffers, useRecall, walksDraft } from "./use-recall.ts";
import { useSession } from "./use-session.ts";

export interface AppProps {
  link: ConversationLink;
  /** The conversation's workspace. Filesystem helpers require the frontend to share its host. */
  workspace?: {
    cwd: string;
    local: boolean;
    modelSelectable?: boolean;
    label?: string;
    access?: "control" | "observe" | "archive";
  };
  team?: TeamContext;
  initialView?: ConversationState;
  onCaptureView?(capture: () => ConversationState): void;
  onReload?(): void;
  onQuit(): void;
  keys?: Keymap;
}

/** A second ctrl+c inside this window quits, as pi's own editor does. */
const QUIT_WINDOW_MS = 500;
/** Entries the conversation draws at first, and how many more each step back shows. */
const WINDOW = 150;
/** Actions that still work while the keyboard walks the boxes: they show the boxes otherwise, or leave. */
const BROWSE_ACTIONS = new Set<Action>(["app.tools.browse", "app.tools.expand", "app.thinking.toggle"]);
const ARCHIVE_ACTIONS = new Set<Action>([
  ...BROWSE_ACTIONS,
  "app.clear",
  "app.exit",
  "app.message.copy",
  "app.suspend",
]);
const ARCHIVE_COMMANDS = new Set(["copy", "session", "hotkeys", "quit"]);

const TEAM_COMMANDS = [
  { name: "tasks", description: "find a task or agent" },
  { name: "attention", description: "answer questions waiting on you" },
  { name: "back", description: "return to the previous conversation" },
  { name: "result", description: "inspect the report, code and independent checks" },
  { name: "join", description: "take the conversation's input lease" },
  { name: "retry", description: "start a fresh attempt of this task" },
  { name: "revise", description: "revise this task's objective" },
  { name: "integrate", description: "integrate this task's retained code" },
  { name: "apply", description: "apply the verified integration to your workspace" },
  { name: "reload-ui", description: "reload this frontend and keep the run alive" },
] as const;
/** Which way each paging key scrolls the conversation. */
const PAGES = new Map<string, -1 | 1>([
  ["pageup", -1],
  ["pagedown", 1],
]);
/** The keys that walk the boxes of work, shown while they do. */
const BROWSE_HINT = "↑↓ pick · enter open · j k scroll · esc back";

/** Holds the fire on one frame, for captures and reduced motion. */
const STILL = process.env.PITUITARY_STILL === "1";

const FIRELIGHT = firelight();

/** Whether the fire leaves its corner for the working line while pi works. */
const TRAVELS = process.env.PITUITARY_FIRE_TRAVELS !== "off";

/** How the fire burns at rest in its corner. */
const BURN: Burn = process.env.PITUITARY_FIRE_BURN === "steady" ? "steady" : "living";

const REMAINS = remains();

/** What a bound action does with its key, the draft, and the standing offer; false leaves the key to the editor. */
type Act = (key: KeyEvent, text: string, standing: Offer | null) => boolean;

export function App({
  link,
  onQuit,
  keys,
  team,
  initialView,
  onCaptureView,
  onReload,
  workspace = { cwd: process.cwd(), local: true },
}: AppProps) {
  const session = useSession(link);
  const { view, state, stats, closed, send, abort } = session;
  const renderer = useRenderer();
  const { width: screenColumns, height: screenRows } = useTerminalDimensions();
  const keymap = useMemo(() => keys ?? loadKeymap(), [keys]);
  const editor = useRef<EditorHandle | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const lastInterrupt = useRef(0);
  const started = useRef(false);
  const [hint, flash] = useFlash();
  const [expanded, setExpanded] = useState(initialView?.expanded ?? false);
  const [thinking, setThinking] = useState(initialView?.thinking ?? true);
  const [browsing, setBrowsing] = useState(false);
  const [picker, setPicker] = useState<PickerSpec | null>(null);
  const [window, setWindow] = useState(initialView?.window ?? WINDOW);
  const [operatorQuestion, setOperatorQuestion] = useState<TeamQuestion | null>(null);
  const [revising, setRevising] = useState<TeamTask | null>(null);
  const [resultTask, setResultTask] = useState<string | null>(null);
  const [draftRows, setDraftRows] = useState(3);
  const [footerRows, setFooterRows] = useState(2);
  // The draft starts in insert mode, where the first escape is the draft's own.
  const [escapes, setEscapes] = useState("esc esc");
  const interruptHint = keymap["app.interrupt"]
    .map((binding) => (/^(esc|escape)$/i.test(binding) ? escapes : binding))
    .join(" / ");
  const stage = useMemo(() => new MascotStage(TRAVELS ? undefined : ["corner"]), []);
  const display = useMemo<Display>(
    () => ({ expanded, thinking, escapes: interruptHint }),
    [expanded, thinking, interruptHint],
  );
  const queued = view.queue.steering.length + view.queue.followUp.length;
  const operatorDialog: DialogRequest | null = operatorQuestion
    ? {
        type: "dialog" as const,
        id: `question:${operatorQuestion.id}`,
        title: `${team?.detail.tasks.find((task) => task.id === operatorQuestion.taskId)?.role ?? "Agent"} asks\n${plain(operatorQuestion.question)}`,
        ...(operatorQuestion.choices.length
          ? { method: "select" as const, options: operatorQuestion.choices.map(plain) }
          : { method: "editor" as const, prefill: "" }),
      }
    : revising
      ? {
          type: "dialog" as const,
          id: `revise:${revising.id}`,
          method: "editor" as const,
          title: `Revise ${revising.role ?? "task"} · a new revision invalidates dependent work`,
          prefill: plain(revising.objective),
        }
      : null;
  const dialogs = operatorDialog ? [operatorDialog] : [];
  const dialog = dialogs[0];
  const choosing = picker !== null || resultTask !== null;
  const taken = Boolean(dialog || choosing);
  const away = taken || browsing;
  const offers = useOffers({ away, queued });
  const recall = useRecall(editor, view.entries, offers);
  const cwd = workspace.cwd;
  const readonly = workspace.access === "observe" || workspace.access === "archive";
  const archived = workspace.access === "archive";
  const canChooseModel = workspace.modelSelectable ?? workspace.local;
  const localCwd = workspace.local && !readonly ? cwd : null;
  const branch = useBranch(link, localCwd);
  const pull = usePullRequest(link, localCwd, branch);
  const commands = useMemo(
    () => [
      ...BUILTINS.filter((command) =>
        readonly ? ARCHIVE_COMMANDS.has(command.name) : command.name !== "model" || canChooseModel,
      ),
      ...(team
        ? TEAM_COMMANDS.filter((command) => onReload || command.name !== "reload-ui").map((command) => ({
            ...command,
            source: "builtin" as const,
          }))
        : []),
    ],
    [canChooseModel, readonly, team, onReload],
  );
  const completions = useCompletion(editor, commands, localCwd);
  const workingRows = statusUp(view, closed) ? (closed || !TRAVELS ? 1 : 2) : 0;
  const teamRows = team
    ? 1 +
      (screenColumns < 120
        ? Math.min(2, team.detail.tasks.filter((task) => task.parentTaskId === team.taskId).length) * 2
        : 0) +
      (team.busy || team.error ? 1 : 0)
    : 0;
  const room = Math.max(0, screenRows - draftRows - footerRows - workingRows - teamRows);
  const popup = taken || Boolean(completions.completion && !away);
  // Panels share half the available rows. A popup keeps at least eight rows for its
  // controls and choices; panels stay visible alongside it wherever space permits.
  const available = Math.min(12, Math.floor(room / 2), popup ? Math.max(0, room - 8) : room);
  const queueRows = Math.min(available, queued > 0 ? queued + (keymap["app.message.dequeue"][0] ? 1 : 0) : 0);
  const popupRows = Math.max(2, room - queueRows);
  const wideTeam = Boolean(team && screenColumns >= 120);
  const captureView = useCallback(
    (): ConversationState => ({
      draft: editor.current?.text() ?? initialView?.draft ?? "",
      cursor: editor.current?.cursor() ?? 0,
      scrollTop: scroll.current?.scrollTop ?? null,
      window,
      expanded,
      thinking,
    }),
    [initialView, window, expanded, thinking],
  );
  useEffect(() => onCaptureView?.(captureView), [onCaptureView, captureView]);
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !state || !initialView) return;
    const restore = () => {
      if (initialView.scrollTop !== null) scroll.current?.scrollTo(initialView.scrollTop);
      restored.current = true;
    };
    renderer.once("frame", restore);
    return () => {
      renderer.off("frame", restore);
    };
  }, [renderer, state, initialView]);
  useEffect(() => {
    if (
      operatorQuestion &&
      team &&
      !team.detail.questions.some(
        (question) => question.id === operatorQuestion.id && question.status === "open",
      )
    )
      setOperatorQuestion(null);
  }, [operatorQuestion, team]);

  const selectTask = (id: string) => {
    if (!team) return;
    const task = team.detail.tasks.find((task) => task.id === id);
    const attempt = team.detail.attempts.find((attempt) => attempt.id === task?.currentAttemptId);
    if (
      !attempt?.conversationId &&
      attempt &&
      ["failed", "stopped", "interrupted"].includes(attempt.status)
    ) {
      setResultTask(id);
      return;
    }
    team.select(id, captureView());
  };
  const showTasks = () => {
    if (!team) return;
    setPicker({
      title: "tasks · choose a conversation",
      items: team.detail.tasks.map((task) => ({
        label: task.role ?? "solo",
        detail: `${taskState(team.detail, task)} · ${plain(task.objective).split("\n")[0] ?? ""}`,
        value: task.id,
        current: task.id === team.taskId,
      })),
      onPick: selectTask,
    });
  };
  const showAttention = () => {
    if (!team) return;
    const questions = team.detail.questions.filter((question) => question.status === "open");
    if (questions.length === 1) {
      setOperatorQuestion(questions[0] ?? null);
      return;
    }
    if (!questions.length) {
      session.notify("info", "No decisions or questions are waiting on you.");
      return;
    }
    setPicker({
      title: "needs your attention",
      items: questions.map((question) => ({
        label: plain(question.question),
        detail: team.detail.tasks.find((task) => task.id === question.taskId)?.role ?? "agent",
        value: question.id,
      })),
      onPick: (id) => setOperatorQuestion(questions.find((question) => question.id === id) ?? null),
    });
  };
  const manage = (operation: Promise<void>) =>
    void operation.catch((error) => session.notify("error", String(error)));
  const answerDialog = (id: string, response: import("@pituitary/session").DialogResponse) => {
    const cancelled = "cancelled" in response && response.cancelled;
    const value = "value" in response ? response.value : undefined;
    if (operatorQuestion && id === `question:${operatorQuestion.id}`) {
      if (!cancelled && value?.trim() && team) manage(team.answer(operatorQuestion.id, value));
      setOperatorQuestion(null);
    } else if (revising && id === `revise:${revising.id}`) {
      if (!cancelled && value?.trim() && team) manage(team.revise(revising, value));
      setRevising(null);
    }
  };

  // A dialog, picker, or panel taking the keyboard ends a walk through the boxes.
  useEffect(() => {
    if (taken) setBrowsing(false);
  }, [taken]);

  // A finished mouse selection goes to the clipboard, the way a terminal copies on select.
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (!text.trim()) return;
    flash(renderer.copyToClipboardOSC52(text) ? "copied" : "the terminal refused the clipboard write");
  });

  const hotkeys = useCallback(() => {
    const bound = (Object.entries(keymap) as [Action, readonly string[]][]).flatMap(([action, bindings]) =>
      bindings.length > 0 &&
      (!action.startsWith("app.team.") || team) &&
      (action !== "app.ui.reload" || onReload) &&
      (!readonly ||
        ARCHIVE_ACTIONS.has(action) ||
        action.startsWith("app.team.") ||
        action === "app.ui.reload")
        ? [`${bindings.join(", ").padEnd(16)} ${action.replace(/^app\./, "")}`]
        : [],
    );
    if (readonly)
      return [
        archived ? "archive keys" : "observer keys",
        ...bound,
        "/                commands",
        "pgup / pgdn      scroll",
      ].join("\n");
    return ["keys", ...bound, `${"enter".padEnd(16)} send`, `${"shift+enter".padEnd(16)} new line`].join(
      "\n",
    );
  }, [keymap, readonly, archived, team, onReload]);

  const command = (name: string, args = "") => {
    if (team && TEAM_COMMANDS.some((command) => command.name === name)) {
      const task = team.detail.tasks.find((task) => task.id === team.taskId);
      if (name === "tasks") showTasks();
      else if (name === "attention") showAttention();
      else if (name === "back") team.back(captureView());
      else if (name === "join") team.join(captureView());
      else if (name === "result") setResultTask(team.taskId);
      else if (name === "reload-ui") onReload?.();
      else if (task && name === "retry") manage(team.retry(task));
      else if (task && name === "revise") setRevising(task);
      else if (task && name === "integrate") manage(team.integrate(task));
      else if (task && name === "apply") manage(team.apply(task));
      return;
    }
    if (readonly && !ARCHIVE_COMMANDS.has(name)) {
      session.notify(
        "info",
        archived
          ? "This conversation is archived and read only."
          : "You are observing this conversation. Join it to write.",
      );
      return;
    }
    if (name === "model" && !canChooseModel) {
      session.notify("warning", "The model is declared by this agent's role. Start a new run to change it.");
      return;
    }
    void runCommand(name, args, {
      link,
      session,
      pick: setPicker,
      copy: (text) => renderer.copyToClipboardOSC52(text),
      quit: onQuit,
      hotkeys,
    });
  };

  const toBottom = () => {
    const box = scroll.current;
    if (box) box.scrollTop = box.scrollHeight;
  };

  const submit = (text: string, followUp = false) => {
    if (!text.trim()) return;
    const managedCommand = /^\/([a-z-]+)(?:\s|$)/.exec(text.trim())?.[1];
    if (team && managedCommand && TEAM_COMMANDS.some((command) => command.name === managedCommand)) {
      command(managedCommand);
      return;
    }
    if (readonly) {
      flash(archived ? "archived conversation · read only" : "observing · join the conversation to write");
      return;
    }
    recall.forget();
    if (closed) {
      // With pi gone nothing can take the text, so it stays where the operator can keep it.
      editor.current?.set(text);
      flash("Disconnected · reload this frontend to reconnect");
      return;
    }
    toBottom();
    const own = builtin(text);
    if (own) {
      command(own.name, own.args);
      return;
    }
    if (canChooseModel && !state?.model) {
      editor.current?.set(text);
      command("model");
      return;
    }
    void send(text, { followUp }).then((accepted) => {
      if (!accepted && !editor.current?.text()) editor.current?.set(text);
    });
  };
  // Choose a configured model before the first local prompt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initial model selection runs once after the native snapshot arrives
  useEffect(() => {
    if (started.current || !state || readonly || !canChooseModel) return;
    started.current = true;
    if (!state.model) command("model");
  }, [state, readonly, canChooseModel]);

  const restoreQueue = async (taken = session.takeQueue()) => {
    const queued = await taken;
    if (!queued) return;
    const current = editor.current?.text() ?? "";
    editor.current?.set(current ? `${queued}\n\n${current}` : queued);
  };

  /** A command run as though typed, for a key bound to it. */
  const runs = (name: string) => () => {
    command(name);
    return true;
  };

  /** Asks pi to move on to the next of something, then says where it landed. */
  const cycle = <Result,>(request: Promise<Result>, landed: (result: Result) => string) => {
    void request
      .then(async (result) => {
        await session.refresh();
        flash(landed(result));
      })
      .catch((cause) => session.notify("error", String(cause)));
    return true;
  };

  /** What each bound action does. */
  const actions = {
    "app.team.tasks": () => {
      if (!team) return false;
      showTasks();
      return true;
    },
    "app.team.back": () => {
      if (!team) return false;
      team.back(captureView());
      return true;
    },
    "app.team.attention": () => {
      if (!team) return false;
      showAttention();
      return true;
    },
    "app.team.join": () => {
      if (!team) return false;
      team.join(captureView());
      return true;
    },
    "app.ui.reload": () => {
      if (!onReload) return false;
      onReload();
      return true;
    },
    "app.clear": (_key, text) => {
      const now = Date.now();
      if (text) editor.current?.set("");
      else if (now - lastInterrupt.current < QUIT_WINDOW_MS) onQuit();
      else flash(`${keyHint(keymap, "app.clear")} again to quit`, QUIT_WINDOW_MS);
      lastInterrupt.current = now;
      return true;
    },
    "app.exit": (_key, text) => {
      if (text) return false;
      onQuit();
      return true;
    },
    "app.interrupt": () => {
      if (view.retry) session.abortRetry();
      else if (view.phase === "compacting") abort();
      else if (view.running) void restoreQueue(session.interrupt());
      return true;
    },
    "app.message.followUp": () => {
      void editor.current?.take().then((taken) => submit(taken, true));
      return true;
    },
    "app.message.dequeue": (key, text, standing) => {
      // Declines below the draft's top row, where up moves the cursor, and with nothing queued.
      if (queued === 0 || !editor.current?.onFirstLine()) return false;
      if (!walksDraft(key) || offers.confirmed("queue", standing, text, "↑ again to edit queued messages")) {
        void restoreQueue();
      }
      return true;
    },
    "app.message.copy": runs("copy"),
    "app.tools.expand": () => {
      setExpanded((current) => !current);
      return true;
    },
    "app.tools.browse": () => {
      if (browsing) setBrowsing(false);
      else if (worked(view.entries)) setBrowsing(true);
      else flash("no thinking or tool calls to step through yet");
      return true;
    },
    "app.thinking.toggle": () => {
      setThinking((current) => !current);
      return true;
    },
    "app.thinking.cycle": () =>
      cycle(link.call({ type: "cycle_thinking_level" }), (result) =>
        result ? `thinking: ${result.level}` : "this model has no thinking levels",
      ),
    "app.editor.external": (_key, text) => {
      const edited = editExternally(renderer, text);
      if (edited !== null) editor.current?.set(edited);
      else flash("external editor failed; your draft is unchanged");
      return true;
    },
    "app.suspend": () => {
      renderer.suspend();
      process.once("SIGCONT", () => renderer.resume());
      process.kill(process.pid, "SIGTSTP");
      return true;
    },
    "app.model.select": runs("model"),
    "app.model.cycleForward": () => {
      if (!canChooseModel) {
        command("model");
        return true;
      }
      return cycle(link.call({ type: "cycle_model" }), (result) =>
        result ? `model: ${modelTitle(result.model)}` : "only one model is available",
      );
    },
  } satisfies Record<Action, Act>;

  /** pgup and pgdn scroll the conversation half a screen; up from its top draws earlier entries. */
  const pageKey = (key: KeyEvent): boolean => {
    const by = PAGES.get(key.name);
    const box = scroll.current;
    if (by === undefined || !box) return false;
    if (by < 0 && box.scrollTop <= 0 && view.entries.length > window)
      setWindow((current) => current + WINDOW);
    else box.scrollBy(by * Math.max(1, Math.floor(box.height / 2)));
    return true;
  };

  /** An open dialog takes every key; ctrl+c or the interrupt key cancels it. */
  const dialogKey = (key: KeyEvent, action: Action | null): boolean => {
    if (!dialog) return false;
    if (action === "app.clear" || action === "app.interrupt") {
      key.preventDefault();
      answerDialog(dialog.id, { type: "dialog_response", id: dialog.id, cancelled: true });
    }
    return true;
  };

  /** While the keyboard walks the boxes the conversation takes its keys; these show it otherwise, page it, or leave. */
  const browseKey = (key: KeyEvent, action: Action | null, text: string, standing: Offer | null) => {
    const took = action && BROWSE_ACTIONS.has(action) ? actions[action](key, text, standing) : pageKey(key);
    if (took) key.preventDefault();
  };

  /** Up from the draft's top row steps back through earlier prompts, and down from its bottom row forward. */
  const historyKey = (key: KeyEvent, text: string, standing: Offer | null): boolean => {
    if (key.meta) return false;
    if (key.name === "up" && editor.current?.onFirstLine()) return recall.back(key, text, standing);
    if (key.name === "down" && editor.current?.onLastLine()) return recall.forward();
    return false;
  };

  /** Runs a command the completion list chose, from an emptied draft. */
  const runChosen = (name: string) => {
    editor.current?.set("");
    submit(name);
  };

  /** A key while the draft holds the keyboard: the completion list's, a bound action, paging, or recall. */
  const draftKey = (key: KeyEvent, action: Action | null, text: string, standing: Offer | null): boolean => {
    if (completions.key(key, action === "app.interrupt", runChosen)) return true;
    // Escape leaves insert mode first, where the draft has a use for it.
    if (action === "app.interrupt" && editor.current?.wantsEscape()) return false;
    return (
      (action !== null && actions[action](key, text, standing)) ||
      pageKey(key) ||
      historyKey(key, text, standing)
    );
  };

  /** Routes a key to whatever holds the keyboard: a dialog, a panel, a picker, the boxes, or the draft. */
  const onKey = (key: KeyEvent) => {
    const standing = offers.take();
    const text = editor.current?.text() ?? "";
    const action = actionFor(keymap, key);
    if (dialogKey(key, action) || choosing) return;
    if (readonly) {
      if (
        action &&
        (ARCHIVE_ACTIONS.has(action) || action.startsWith("app.team.") || action === "app.ui.reload")
      ) {
        if (actions[action](key, "", null)) key.preventDefault();
      } else if (browsing) browseKey(key, action, "", null);
      else {
        if (key.sequence === "/")
          setPicker({
            title: archived ? "archived conversation" : "observing conversation",
            items: commands.map((item) => ({
              label: `/${item.name}`,
              detail: item.description,
              value: item.name,
            })),
            onPick: (name) => command(name),
          });
        else pageKey(key);
        key.preventDefault();
      }
      return;
    }
    if (browsing) {
      browseKey(key, action, text, standing);
      return;
    }
    // Nothing else takes the keyboard for long, so a key that finds the editor without it gives it back.
    if (!editor.current?.hasFocus()) editor.current?.focus();
    // A half-typed command in the draft, such as a count or ctrl+v, takes the next key whatever it is.
    if (editor.current?.pending()) return;
    if (draftKey(key, action, text, standing)) key.preventDefault();
  };

  useHeldKeys(editor, onKey, !away, dialog ?? null);

  usePaste((event) => {
    if (readonly && !operatorDialog) {
      event.preventDefault();
      return;
    }
  });

  const shownHint = browsing ? BROWSE_HINT : hint;
  return (
    <KeymapProvider value={keymap}>
      <MascotProvider value={stage}>
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
          {team ? (
            <TeamHeader
              team={team}
              tasks={showTasks}
              attention={showAttention}
              back={() => team.back(captureView())}
              result={() => setResultTask(team.taskId)}
            />
          ) : null}
          <box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
            <Conversation
              ref={scroll}
              entries={view.entries}
              running={view.running}
              local={workspace.local && !readonly}
              modelSelectable={canChooseModel && !readonly}
              display={display}
              window={window}
              browsing={browsing}
              onLeave={() => setBrowsing(false)}
            />
            {wideTeam && team ? <TeamCards team={team} wide open={selectTask} /> : null}
          </box>
          {!wideTeam && team ? <TeamCards team={team} wide={false} open={selectTask} /> : null}
          {team?.busy || team?.error ? (
            <box paddingLeft={1} flexShrink={0}>
              <text fg={team.error ? theme.error : theme.dim} truncate wrapMode="none">
                {plain(team.error ?? team.busy ?? "")}
              </text>
            </box>
          ) : null}
          <box
            flexDirection="column"
            flexShrink={0}
            minHeight={0}
            overflow="hidden"
            justifyContent="flex-end"
          >
            <Working view={view} hint={shownHint} closed={closed} escapes={interruptHint} />
            <Queue queue={view.queue} dequeue={keymap["app.message.dequeue"][0]} rows={queueRows} />
            {resultTask && team ? (
              <TaskResult
                detail={team.detail}
                taskId={resultTask}
                rows={popupRows}
                close={() => setResultTask(null)}
                integrate={(task) => manage(team.integrate(task))}
                retry={(task) => manage(team.retry(task))}
                revise={(task) => {
                  setResultTask(null);
                  setRevising(task);
                }}
                apply={(task) => manage(team.apply(task))}
                copy={(text) => {
                  renderer.copyToClipboardOSC52(text);
                  flash("copied report");
                }}
              />
            ) : (
              <Popups
                dialogs={dialogs}
                picker={picker}
                completion={
                  completions.completion && !away
                    ? { items: completions.completion.items, index: completions.index }
                    : null
                }
                rows={popupRows}
                onAnswer={answerDialog}
                onClosePicker={() => setPicker(null)}
              />
            )}
          </box>
          <box
            flexDirection="column"
            flexShrink={0}
            onSizeChange={function (this: BoxRenderable) {
              setDraftRows(this.height);
            }}
          >
            {readonly ? (
              <box paddingLeft={1} paddingTop={1} height={2}>
                <text fg={theme.dim} truncate wrapMode="none">
                  {shownHint ||
                    `${archived ? "Archived · read only" : "Observing · alt+i join"} · ${keyHint(keymap, "app.message.copy")} copy · / commands · ${keyHint(keymap, "app.exit")} close`}
                </text>
              </box>
            ) : (
              <Editor
                ref={editor}
                onSubmit={submit}
                steering={view.running}
                focused={!away}
                initialDraft={initialView?.draft}
                initialCursor={initialView?.cursor}
                note={
                  canChooseModel && state && !state.model
                    ? "Choose a model · ctrl+l"
                    : statusUp(view, closed)
                      ? null
                      : shownHint
                }
                confirm={offers.asking}
                onNotice={(text) => session.notify("warning", text)}
                onEscapes={(count) => setEscapes(count === 1 ? "esc" : "esc esc")}
                onChange={(text, cursor) => {
                  completions.follow(text, cursor);
                  offers.edited(text);
                  recall.edited(text);
                }}
              />
            )}
          </box>
          <box
            flexDirection="column"
            flexShrink={0}
            onSizeChange={function (this: BoxRenderable) {
              setFooterRows(this.height);
            }}
          >
            <Footer
              state={state}
              stats={stats}
              cwd={cwd}
              location={workspace.local ? undefined : (workspace.label ?? "agent")}
              branch={branch}
              pull={pull}
            />
          </box>
          <Mascot stage={stage} still={STILL} burn={BURN} light={FIRELIGHT} left={REMAINS} />
        </box>
      </MascotProvider>
    </KeymapProvider>
  );
}
