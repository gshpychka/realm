import type { BoxRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { usePaste, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/react";
import type { AgentLink, BridgeHost } from "@pituitary/rpc";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILTINS, builtin } from "./commands/commands.ts";
import { frameRows } from "./commands/debug.ts";
import { runCommand } from "./commands/run-command.ts";
import { useCommands } from "./commands/use-commands.ts";
import type { ChecklistSpec } from "./components/checklist.tsx";
import { Conversation, type Display } from "./components/conversation.tsx";
import { useCustomViews } from "./components/custom-panel.tsx";
import { Editor, type EditorHandle } from "./components/editor.tsx";
import { Footer } from "./components/footer.tsx";
import { type Burn, Mascot, MascotProvider, MascotStage } from "./components/mascot.tsx";
import type { PickerSpec } from "./components/picker.tsx";
import { Popups } from "./components/popups.tsx";
import { Queue } from "./components/queue.tsx";
import { besideTodo, TodoPanel, Widgets } from "./components/widgets.tsx";
import { statusUp, Working } from "./components/working.tsx";
import { editExternally } from "./external-editor.ts";
import { firelight } from "./firelight.ts";
import { usePullRequest } from "./github/use-pull-request.ts";
import { type Action, actionFor, type Keymap, loadKeymap } from "./keymap.ts";
import { KeymapProvider, keyHint } from "./keymap-context.tsx";
import { modelTitle } from "./model-names.ts";
import { remains } from "./remains.ts";
import { theme } from "./theme.ts";
import { latestTasks } from "./tools.ts";
import { worked } from "./transcript.ts";
import { useBranch } from "./use-branch.ts";
import { useCompletion } from "./use-completion.ts";
import { useFlash } from "./use-flash.ts";
import { useHeldKeys } from "./use-held-keys.ts";
import { useLimits } from "./use-limits.ts";
import { type Offer, useOffers, useRecall, walksDraft } from "./use-recall.ts";
import { useSession } from "./use-session.ts";

export interface AppProps {
  link: AgentLink;
  /** The worker's workspace. Local filesystem helpers run only when it shares this machine. */
  workspace?: { cwd: string; local: boolean; label?: string };
  onQuit(): void;
  /** Told the file pi keeps the session in as it changes, so any way out can offer to resume it. */
  onSessionFile?(file: string | undefined): void;
  /** Bindings by pi action name; the operator's `keybindings.json` over pi's defaults otherwise. */
  keys?: Keymap;
  /** What to open on: the session picker or a first prompt the command line asked for, or a notice. */
  startWith?: { resume?: boolean; prompt?: string | null; notice?: string };
  /** Draws the components extensions open, and carries the operator's keys to them. */
  bridge?: BridgeHost;
  /** Hands the terminal to stock pi on the session, with `text` in its editor. */
  onHandoff?(text: string, sessionFile?: string): void;
  /** Starts pi afresh on the session, with `notice` in the conversation once it is up. */
  onRestart?(notice: string, sessionFile?: string): void;
}

/** A second ctrl+c inside this window quits, as pi's own editor does. */
const QUIT_WINDOW_MS = 500;
/** Entries the conversation draws at first, and how many more each step back shows. */
const WINDOW = 150;
/** Actions that still work while the keyboard walks the boxes: they show the boxes otherwise, or leave. */
const BROWSE_ACTIONS = new Set<Action>(["app.tools.browse", "app.tools.expand", "app.thinking.toggle"]);
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
  onSessionFile,
  keys,
  startWith,
  bridge,
  onHandoff,
  onRestart,
  workspace = { cwd: process.cwd(), local: true },
}: AppProps) {
  const session = useSession(link);
  const sessionFile = session.state?.sessionFile;
  useEffect(() => onSessionFile?.(sessionFile), [onSessionFile, sessionFile]);
  const { view, state, stats, extensionUi, closed, send, abort, answer } = session;
  const renderer = useRenderer();
  const { width: screenColumns, height: screenRows } = useTerminalDimensions();
  const keymap = useMemo(() => keys ?? loadKeymap(), [keys]);
  const editor = useRef<EditorHandle | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const lastInterrupt = useRef(0);
  const started = useRef(false);
  const [hint, flash] = useFlash();
  const [expanded, setExpanded] = useState(false);
  const [thinking, setThinking] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [picker, setPicker] = useState<PickerSpec | null>(null);
  const [checklist, setChecklist] = useState<ChecklistSpec | null>(null);
  const [window, setWindow] = useState(WINDOW);
  const [draftRows, setDraftRows] = useState(3);
  const [footerRows, setFooterRows] = useState(2);
  // The draft starts in insert mode, where the first escape is the draft's own.
  const [escapes, setEscapes] = useState("esc esc");
  const interruptHint = keymap["app.interrupt"]
    .map((binding) => (/^(esc|escape)$/i.test(binding) ? escapes : binding))
    .join(" / ");
  const custom = useCustomViews(bridge).at(-1);
  const limits = useLimits(bridge);
  const stage = useMemo(() => new MascotStage(TRAVELS ? undefined : ["corner"]), []);
  const display = useMemo<Display>(
    () => ({ expanded, thinking, escapes: interruptHint }),
    [expanded, thinking, interruptHint],
  );
  const tasks = useMemo(() => latestTasks(view.entries), [view.entries]);
  const widgets = useMemo(() => besideTodo(extensionUi.widgets, tasks), [extensionUi.widgets, tasks]);
  const queued = view.queue.steering.length + view.queue.followUp.length;
  const dialog = extensionUi.dialogs[0];
  const choosing = picker !== null || checklist !== null;
  const taken = Boolean(dialog || choosing || custom);
  const away = taken || browsing;
  const offers = useOffers({ away, queued });
  const recall = useRecall(editor, view.entries, offers);
  const cwd = workspace.cwd;
  const localCwd = workspace.local ? cwd : null;
  const branch = useBranch(link, localCwd);
  const pull = usePullRequest(link, localCwd, branch);
  const { commands: listedCommands, reread } = useCommands(link, state?.sessionId);
  const commands = useMemo(
    () => (workspace.local ? listedCommands : listedCommands.filter((command) => !command.localOnly)),
    [listedCommands, workspace.local],
  );
  const completions = useCompletion(editor, commands, localCwd);
  const workingRows = statusUp(view, closed) ? (closed || !TRAVELS ? 1 : 2) : 0;
  const room = Math.max(0, screenRows - draftRows - footerRows - workingRows);
  const popup = taken || Boolean(completions.completion && !away);
  // Panels share half the available rows. A popup keeps at least eight rows for its
  // controls and choices; panels stay visible alongside it wherever space permits.
  const available = Math.min(12, Math.floor(room / 2), popup ? Math.max(0, room - 8) : room);
  const wants = [
    queued > 0 ? queued + (keymap["app.message.dequeue"][0] ? 1 : 0) : 0,
    tasks.some((task) => task.status !== "completed" && task.status !== "deleted")
      ? Math.min(9, tasks.length + 1)
      : 0,
    widgets
      .filter((widget) => widget.placement === "aboveEditor")
      .reduce((sum, widget) => sum + widget.lines.length, 0),
    widgets
      .filter((widget) => widget.placement === "belowEditor")
      .reduce((sum, widget) => sum + widget.lines.length, 0),
  ];
  const panelRows = wants.map(() => 0);
  for (let left = available; left > 0; ) {
    let used = false;
    for (let index = 0; index < wants.length && left > 0; index++) {
      if ((panelRows[index] ?? 0) >= (wants[index] ?? 0)) continue;
      panelRows[index] = (panelRows[index] ?? 0) + 1;
      left--;
      used = true;
    }
    if (!used) break;
  }
  const popupRows = Math.max(2, room - panelRows.reduce((sum, rows) => sum + rows, 0));

  // A dialog, picker, or panel taking the keyboard ends a walk through the boxes.
  useEffect(() => {
    if (taken) setBrowsing(false);
  }, [taken]);

  // The border and padding take four columns and two rows of the panel.
  useEffect(() => {
    bridge?.resize(Math.max(10, screenColumns - 4), Math.max(3, popupRows - 2));
  }, [bridge, screenColumns, popupRows]);

  useEffect(() => {
    if (extensionUi.title) renderer.setTerminalTitle(extensionUi.title);
  }, [renderer, extensionUi.title]);

  // A finished mouse selection goes to the clipboard, the way a terminal copies on select.
  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (!text.trim()) return;
    flash(renderer.copyToClipboardOSC52(text) ? "copied" : "the terminal refused the clipboard write");
  });

  const hotkeys = useCallback(() => {
    const bound = (Object.entries(keymap) as [Action, readonly string[]][]).flatMap(([action, bindings]) =>
      bindings.length > 0 ? [`${bindings.join(", ").padEnd(16)} ${action.replace(/^app\./, "")}`] : [],
    );
    return ["keys", ...bound, `${"enter".padEnd(16)} send`, `${"shift+enter".padEnd(16)} new line`].join(
      "\n",
    );
  }, [keymap]);

  const command = useCallback(
    (name: string, args = "") => {
      if (!workspace.local && BUILTINS.some((command) => command.name === name && command.localOnly)) {
        session.notify(
          "warning",
          name === "model"
            ? "The model is declared by this agent's role. Start a new run to change it."
            : `/${name} requires a local session.`,
        );
        return;
      }
      if (!workspace.local && name === "export" && args.endsWith(".jsonl")) {
        session.notify(
          "warning",
          "JSONL export requires a local session. HTML exports are saved in the agent workspace.",
        );
        return;
      }
      void runCommand(name, args, {
        link,
        session,
        pick: setPicker,
        pickMany: setChecklist,
        setDraft: (text) => editor.current?.set(text),
        copy: (text) => renderer.copyToClipboardOSC52(text),
        quit: onQuit,
        hotkeys,
        handoff: (text) => {
          if (onHandoff) onHandoff(text, state?.sessionFile);
          else session.notify("warning", `${text.split(" ")[0]} runs in pi itself; start \`pi\` for it`);
        },
        restart: (notice) => {
          if (onRestart) onRestart(notice, state?.sessionFile);
          else session.notify("warning", "Stop this run and start a new one to apply this setting.");
        },
        reloadCommands: reread,
        limits: () => bridge?.limits() ?? null,
        screen: () => frameRows(renderer.currentRenderBuffer),
      });
    },
    [
      link,
      session,
      renderer,
      onQuit,
      onHandoff,
      onRestart,
      hotkeys,
      state?.sessionFile,
      bridge,
      reread,
      workspace.local,
    ],
  );

  const toBottom = () => {
    const box = scroll.current;
    if (box) box.scrollTop = box.scrollHeight;
  };

  const submit = (text: string, followUp = false) => {
    if (!text.trim()) return;
    recall.forget();
    if (closed) {
      // With pi gone nothing can take the text, so it stays where the operator can keep it.
      editor.current?.set(text);
      flash("pi has stopped; quit and start pituitary again");
      return;
    }
    toBottom();
    const own = builtin(text);
    if (own) {
      command(own.name, own.args);
      return;
    }
    const name = /^\/(\S+)/.exec(text)?.[1];
    const before = session.activity() + (bridge?.opens() ?? 0);
    void send(text, { followUp }).then((accepted) => {
      if (!accepted && !editor.current?.text()) editor.current?.set(text);
      else if (accepted && name && session.activity() + (bridge?.opens() ?? 0) === before) {
        void sayIfSilent(name);
      }
    });
  };

  /**
   * An extension command finishes before pi answers, so one that sent nothing showed nothing.
   * pi's list, asked for once it has answered, holds every extension it loaded; the list kept
   * for completion may still be on its way.
   */
  const sayIfSilent = (name: string) =>
    link.call({ type: "get_commands" }).then(
      ({ commands }) => {
        if (commands.some((each) => each.source === "extension" && each.name === name)) {
          session.notify("info", `/${name} finished without showing anything`);
        }
      },
      () => {},
    );

  // The command line's own requests, once pi has answered its first state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when pi first answers
  useEffect(() => {
    if (started.current || !state) return;
    started.current = true;
    if (startWith?.notice) session.notify("info", startWith.notice);
    if (startWith?.resume) command("resume");
    else if (startWith?.prompt) submit(startWith.prompt);
  }, [state]);

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
      else if (session.shellBusy) session.abortBash();
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
      if (!workspace.local) {
        command("model");
        return true;
      }
      return cycle(link.call({ type: "cycle_model" }), (result) =>
        result ? `model: ${modelTitle(result.model)}` : "only one model is available",
      );
    },
    "app.session.new": runs("new"),
    "app.session.resume": runs("resume"),
    "app.session.fork": runs("fork"),
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
      answer(dialog.id, { type: "extension_ui_response", id: dialog.id, cancelled: true });
    }
    return true;
  };

  /** An extension's own component takes every key; ctrl+c closes it. */
  const customKey = (key: KeyEvent, action: Action | null): boolean => {
    if (!custom || !bridge) return false;
    key.preventDefault();
    if (action === "app.clear") bridge.cancel(custom.id);
    else bridge.input(custom.id, key.raw || key.sequence);
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
    if (dialogKey(key, action) || customKey(key, action) || choosing) return;
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

  useHeldKeys(editor, onKey, !away, dialog ?? custom ?? null);

  usePaste((event) => {
    if (!custom || !bridge) return;
    event.preventDefault();
    bridge.input(custom.id, `\x1b[200~${new TextDecoder().decode(event.bytes)}\x1b[201~`);
  });

  const shownHint = browsing ? BROWSE_HINT : hint;
  return (
    <KeymapProvider value={keymap}>
      <MascotProvider value={stage}>
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
          <Conversation
            ref={scroll}
            entries={view.entries}
            running={view.running}
            local={workspace.local}
            display={display}
            window={window}
            browsing={browsing}
            onLeave={() => setBrowsing(false)}
          />
          <box
            flexDirection="column"
            flexShrink={1}
            minHeight={0}
            overflow="hidden"
            justifyContent="flex-end"
          >
            <TodoPanel tasks={tasks} rows={panelRows[1]} />
            <Working view={view} hint={shownHint} closed={closed} escapes={interruptHint} />
            <Queue queue={view.queue} dequeue={keymap["app.message.dequeue"][0]} rows={panelRows[0]} />
            <Widgets widgets={widgets} placement="aboveEditor" rows={panelRows[2]} />
            <Popups
              dialogs={extensionUi.dialogs}
              custom={custom}
              picker={picker}
              checklist={checklist}
              completion={
                completions.completion && !away
                  ? { items: completions.completion.items, index: completions.index }
                  : null
              }
              rows={popupRows}
              onAnswer={answer}
              onClosePicker={() => setPicker(null)}
              onCloseChecklist={() => setChecklist(null)}
            />
          </box>
          <box
            flexDirection="column"
            flexShrink={0}
            onSizeChange={function (this: BoxRenderable) {
              setDraftRows(this.height);
            }}
          >
            <Editor
              ref={editor}
              onSubmit={submit}
              steering={view.running}
              focused={!away}
              seed={extensionUi.editor}
              note={statusUp(view, closed) ? null : shownHint}
              confirm={offers.asking}
              onNotice={(text) => session.notify("warning", text)}
              onEscapes={(count) => setEscapes(count === 1 ? "esc" : "esc esc")}
              onChange={(text, cursor) => {
                completions.follow(text, cursor);
                offers.edited(text);
                recall.edited(text);
              }}
            />
          </box>
          <Widgets widgets={widgets} placement="belowEditor" rows={panelRows[3]} />
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
              statuses={extensionUi.statuses}
              turnStatuses={extensionUi.turnStatuses}
              cwd={cwd}
              location={workspace.local ? undefined : (workspace.label ?? "agent")}
              branch={branch}
              pull={pull}
              limits={limits}
            />
          </box>
          <Mascot stage={stage} still={STILL} burn={BURN} light={FIRELIGHT} left={REMAINS} />
        </box>
      </MascotProvider>
    </KeymapProvider>
  );
}
