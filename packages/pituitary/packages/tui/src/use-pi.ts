import { dirname } from "node:path";
import type { UserEntry } from "@pituitary/session";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type Command, PI_SCREENS, SKILL_REQUEST, shellCommand } from "./commands/commands.ts";
import type { EditorHandle } from "./components/editor.tsx";
import type { PickerKey, PickerSpec } from "./components/picker.tsx";
import type { Keymap } from "./keymap.ts";
import type { PiControls, PiWorkspace } from "./pi.ts";
import type { SessionSummary } from "./pi-bridge.ts";
import { PI_EXTENSIONS } from "./pi-extensions.ts";
import { treeNavigation } from "./pi-navigation.ts";
import { forkRows, sessionDetail, sessionLabel, sessionRows } from "./pi-sessions.ts";
import { tilde } from "./place.ts";
import type { Question } from "./use-ask.ts";
import type { SessionController } from "./use-session.ts";
import { typed } from "./user-text.ts";

export interface UsePiOptions {
  pi: PiControls | undefined;
  session: SessionController;
  editor: RefObject<EditorHandle | null>;
  /** The App's list: a spec opens one, null closes it, and an update can open one only where none is. */
  pick: Dispatch<SetStateAction<PickerSpec | null>>;
  ask(question: Question): Promise<string | null>;
  /** Shows a passing hint; what it returns takes the hint down early. */
  flash(text: string): () => void;
  /** Hands the terminal to another program and takes it back. */
  terminal: { suspend(): void; resume(): void };
}

/** What the App does with regular Pi beyond the conversation. */
export interface Pi {
  workspace: PiWorkspace;
  /** Pi's extension, prompt-template and skill commands, without Pituitary's own bridge. */
  commands: Command[];
  /** Pi's keybindings under Pituitary's own, read again by each /reload, as Pi's own /reload does. */
  keymap: Keymap;
  /** Runs `/name args` when it is a session command or one of Pi's screens; false for anything else. */
  run(name: string, args: string): boolean;
  /**
   * Pi's name for the command of Pituitary's usage extension: Pi renames commands whose names
   * collide, as `usage:1` and `usage:2`. Undefined while Pi has not loaded the extension.
   */
  usageCommand: string | undefined;
  /** Opens or closes the provider usage card, through Pituitary's usage extension, whatever Pi named its command. */
  showUsage(open: boolean): void;
  /**
   * Runs a draft that is a shell command, `!command`, or `!!command` to keep its output from
   * the model; false for any other draft. A draft it cannot run yet goes back to the editor.
   */
  shell(draft: string): boolean;
  /** Forks a new session from before the prompt the transcript shows as `prompt`, which goes into the draft. */
  forkAt(prompt: UserEntry): void;
  /** Moves back before the prompt the transcript shows as `prompt`, which goes into the draft, as /tree does. */
  editAt(prompt: UserEntry): void;
  /** A move is summarizing the branch it leaves. */
  summarizing: boolean;
  /**
   * Stops what Pituitary set Pi doing outside a run: a move summarizing the branch it leaves,
   * or the operator's shell command. False when there is neither.
   */
  stop(): boolean;
}

const subscribeNone = () => () => {};
const NO_WORKSPACE: PiWorkspace = { cwd: process.cwd(), commands: [], argumentHints: {} };

/**
 * Regular Pi's sessions run from Pituitary's own screen: new, fork, tree, clone and resume
 * replace or move the session without remounting anything, so the draft and its undo history
 * stay. The operator's shell commands run through Pi too. Null for Dura.
 */
export function usePi({ pi, session, editor, pick, ask, flash, terminal }: UsePiOptions): Pi | null {
  const conversation = pi?.conversation;
  const workspace = useSyncExternalStore(
    conversation?.subscribe ?? subscribeNone,
    conversation?.workspace ?? (() => NO_WORKSPACE),
  );
  // Continuations run after pickers and dialogs; they read the session as it is then.
  const latest = useRef(session);
  latest.current = session;
  const resumed = useRef(false);
  const [keymap, setKeymap] = useState(() => pi?.keymap());
  // What stops a move that is summarizing the branch it leaves, while one is.
  const [stopSummary, setStopSummary] = useState<(() => void) | null>(null);
  // Settles once the operator's running shell command ends.
  const shellEnd = useRef<Promise<void>>(Promise.resolve());
  const commands = useMemo(
    () =>
      workspace.commands
        .filter((command) => command.name !== workspace.bridge)
        .map((command): Command => {
          // A skill frames a request; a prompt template takes what its frontmatter declares.
          const args =
            command.source === "skill"
              ? SKILL_REQUEST
              : command.source === "prompt"
                ? workspace.argumentHints[command.name]
                : undefined;
          return {
            name: command.name,
            description: command.description ?? "",
            source: command.source,
            ...(args ? { args } : {}),
            scope: command.sourceInfo.scope,
            path: command.sourceInfo.path,
          };
        }),
    [workspace],
  );
  const actions = pi
    ? sessionActions(pi, latest, {
        editor,
        pick,
        ask,
        flash,
        terminal,
        reloadKeys: () => setKeymap(pi.keymap()),
        summarizing: (stop) => {
          setStopSummary(() => stop);
          // Only this move's own end takes its stop away.
          return () => setStopSummary((current) => (current === stop ? null : current));
        },
      })
    : null;
  // `pituitary --resume` opens the picker once the session has loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the picker opens once, on the first snapshot
  useEffect(() => {
    if (resumed.current || !session.state || !pi?.resumeAtStart || !actions) return;
    resumed.current = true;
    actions.run("resume", "");
  }, [session.state, pi]);
  if (!pi || !actions || !keymap) return null;
  const { conversation: link } = pi;
  return {
    workspace,
    commands,
    keymap,
    run: actions.run,
    forkAt: actions.forkAt,
    editAt: actions.editAt,
    usageCommand: link.commandOf(PI_EXTENSIONS.usage),
    showUsage: (open) => {
      const name = link.commandOf(PI_EXTENSIONS.usage);
      if (!name) session.notify("warning", "Pi has not loaded Pituitary's provider usage extension.");
      else
        void link
          .prompt(`/${name} ${open ? "on" : "off"}`)
          .catch((error) => session.notify("warning", describe(error)));
    },
    shell: (draft) => {
      const shell = shellCommand(draft);
      if (!shell) return false;
      if (!shell.command) {
        editor.current?.set(draft);
        flash("type a command after ! to run it, or after !! to keep its output from pi");
      } else if (link.shellRunning) {
        // As in Pi, one command runs at a time; the hint goes once the running one ends.
        editor.current?.set(draft);
        void shellEnd.current.then(flash("a shell command is already running · stop it first"));
      } else shellEnd.current = link.bash(shell.command, shell.excluded);
      return true;
    },
    summarizing: stopSummary !== null,
    stop: () => {
      if (stopSummary) stopSummary();
      else if (link.shellRunning)
        void link.abortBash().catch((error) => session.notify("error", describe(error)));
      else return false;
      return true;
    },
  };
}

/** Which sessions the resume list shows: this project's, or every project's. */
type Scope = "here" | "all";
/** What the resume list keeps when it comes back after a key's work: the filter, and the session to start on. */
type Keep = { query?: string; selected?: string };

function sessionActions(
  pi: PiControls,
  latest: RefObject<SessionController>,
  {
    editor,
    pick,
    ask,
    flash,
    terminal,
    reloadKeys,
    summarizing,
  }: Omit<UsePiOptions, "pi" | "session"> & {
    reloadKeys(): void;
    /** Says a move is summarizing, with what stops it; what it returns says the move is done. */
    summarizing(stop: () => void): () => void;
  },
): Pick<Pi, "run" | "forkAt" | "editAt"> {
  const { conversation } = pi;
  const notify: SessionController["notify"] = (level, text, file) => latest.current.notify(level, text, file);
  const kept = () => notify("info", "An extension kept Pi on this session.");
  const failed = (name: string) => (error: unknown) => notify("error", `/${name}: ${describe(error)}`);

  /** Puts `text` at the top of the draft, what was there below it, with the cursor at its end. */
  const intoDraft = (text: string) => {
    const draft = editor.current?.text() ?? "";
    editor.current?.set(draft.trim() ? `${text}\n\n${draft}` : text, text.length);
  };
  /** What Pi is busy with: a run, or a compaction, which a manual /compact runs outside any run. */
  const busy = (): "run" | "compaction" | null => {
    const { view } = latest.current;
    return view.running ? "run" : view.phase === "compacting" ? "compaction" : null;
  };
  /**
   * Pi replaces a session only while idle. As Pi's own screen does, the queue comes back and the
   * run or compaction stops first. Returns what was queued.
   */
  const settle = async (): Promise<string> => {
    if (!busy()) return "";
    const queued = await latest.current.takeQueue();
    await conversation.abort();
    return queued;
  };
  /** Settles, putting what was queued at the top of the draft. */
  const settled = async () => {
    const queued = await settle();
    if (queued) intoDraft(queued);
  };

  const tree = treeNavigation({
    conversation,
    pick,
    ask,
    flash,
    notify,
    refresh: () => latest.current.refresh(),
    editor,
    settle,
    intoDraft,
    summarizing,
  });

  const forkAt = async (entryId: string) => {
    const queued = await settle();
    const draft = editor.current?.text() ?? "";
    const forked = await conversation.fork(entryId).catch((error: unknown) => {
      // What was taken back from the run stays the operator's.
      if (queued) intoDraft(queued);
      throw error;
    });
    if (!forked) {
      if (queued) intoDraft(queued);
      return kept();
    }
    // As in Pi, the earlier prompt replaces the draft, which nvim's undo keeps; the queue taken
    // back from the run stays under it. A skill it loaded comes back as the command that loaded it.
    const prompt = typed(forked.text);
    editor.current?.set([prompt, queued].filter(Boolean).join("\n\n"), prompt.length);
    notify(
      "info",
      `Forked into a new session · editing your earlier prompt${draft.trim() ? " · esc u brings your draft back" : ""}`,
    );
  };
  /**
   * The session's own entry for the prompt the transcript shows as `prompt`, which the branch the
   * session is on holds. Prompts sent within the same millisecond share a key; their text tells them apart.
   */
  const entryOf = async (prompt: UserEntry): Promise<string | null> => {
    if (prompt.key === undefined) return null;
    const found = (await conversation.branchPrompts()).filter((each) => each.key === prompt.key);
    return (found.find((each) => each.text === prompt.text) ?? found[0])?.entryId ?? null;
  };
  /** Runs `work` on the session's entry for `prompt`, or says the prompt is not on this branch. */
  const atPrompt = (name: string, work: (entryId: string) => Promise<void>) => (prompt: UserEntry) =>
    void entryOf(prompt)
      .then((entryId) =>
        entryId ? work(entryId) : notify("info", "That prompt is not on the branch the session is on."),
      )
      .catch(failed(name));
  const fork = async () => {
    const prompts = await conversation.branchPrompts();
    if (!prompts.length) return notify("info", "There is no earlier prompt to fork from yet.");
    pick({
      title: "fork · a new session from before an earlier prompt",
      items: forkRows(prompts, Date.now()),
      onPick: (entryId) => void forkAt(entryId).catch(failed("fork")),
    });
  };
  const clone = async () => {
    await settled();
    if (await conversation.clone()) notify("info", "Cloned this session into a new one");
    else kept();
  };
  const fresh = async () => {
    await settled();
    if (!(await conversation.newSession())) kept();
  };

  /**
   * The resume list of `wanted` sessions; a project without saved sessions yet lists every
   * project's instead. `again` marks the list coming back after a key's work, which stays shut
   * when another list opened meanwhile.
   */
  const resume = async (wanted: Scope, keep: Keep = {}, again = false): Promise<void> => {
    let all = wanted === "all";
    let { sessions } = await conversation.bridge({ kind: "sessions", all });
    const elsewhere = !all && !sessions.length;
    if (elsewhere) {
      all = true;
      ({ sessions } = await conversation.bridge({ kind: "sessions", all }));
    }
    if (!sessions.length) return notify("info", "Pi has no saved sessions yet.");
    const now = Date.now();
    const current = latest.current.state?.sessionFile;
    const named = (path: string) => {
      const target = sessions.find((each) => each.path === path);
      return {
        label: target ? sessionLabel(target) : tilde(path),
        detail: target && sessionDetail(target, now),
      };
    };
    /** A key's work runs with the list shut, so nothing picks from a list it is changing; the list then comes back. */
    const act = (work: () => Promise<Keep>, scope: Scope = wanted) => {
      pick(null);
      void work()
        .then((keep) => resume(scope, keep, true))
        .catch(failed("resume"));
    };
    const keys: PickerKey[] = [
      {
        action: "app.session.rename",
        label: "rename",
        run: (path, query) =>
          act(async () => {
            const { label } = named(path);
            const name = (
              await ask({ method: "input", title: `Rename “${label}”`, placeholder: label })
            )?.trim();
            if (!name) return { query, selected: path };
            await conversation.bridge({ kind: "rename-session", path, name });
            // The filter may not match the new name, so the whole list comes back, on the renamed session.
            return { selected: path };
          }),
      },
      {
        action: "app.session.delete",
        label: "delete",
        run: (path, query) => {
          if (path === current) return flash("Pi has this session open, so it stays");
          act(async () => {
            const { label, detail } = named(path);
            const answer = await ask({
              method: "select",
              title: `Delete “${label}”?${detail ? ` · ${detail}` : ""}\nIt goes to the trash where a trash command is installed, otherwise for good.`,
              options: ["Keep it", "Delete it"],
            });
            if (answer !== "Delete it") return { query, selected: path };
            const { trashed } = await conversation.bridge({ kind: "delete-session", path });
            flash(trashed ? "moved the session to the trash" : "deleted the session");
            return { query };
          });
        },
      },
      // With nothing in this project there is nothing to switch to.
      ...(elsewhere
        ? []
        : [
            {
              action: "tui.input.tab",
              label: all ? "this project" : "every project",
              run: (_path, query) => act(async () => ({ query }), all ? "here" : "all"),
            } satisfies PickerKey,
          ]),
    ];
    const spec: PickerSpec = {
      title: elsewhere
        ? "resume · every project's sessions · none in this project yet"
        : all
          ? "resume · every project's sessions"
          : "resume · this project's sessions",
      items: sessionRows(sessions, { current, all, now }),
      ...keep,
      keys,
      onPick: (path) => {
        const target = sessions.find((each) => each.path === path);
        if (target) void open(target).catch(failed("resume"));
      },
    };
    pick(again ? (shown) => shown ?? spec : spec);
  };
  const open = async (target: SessionSummary) => {
    if (target.path === latest.current.state?.sessionFile) return flash("this is the session you are in");
    await settled();
    const from = conversation.workspace().cwd;
    if (!(await conversation.switchSession(target.path))) return kept();
    const to = conversation.workspace().cwd;
    if (to !== from) notify("info", `Working in ${tilde(to)}, where this session started`);
  };

  const screen = async (command: string) => {
    const work = busy();
    if (work)
      return notify(
        "warning",
        `${command} opens Pi's own screen once the ${work} finishes or is interrupted.`,
      );
    terminal.suspend();
    try {
      await pi.handoff(command);
    } finally {
      terminal.resume();
    }
    await latest.current.refresh();
  };

  const go = (name: string, work: () => Promise<void>) => {
    void work().catch(failed(name));
    return true;
  };
  return {
    forkAt: atPrompt("fork", forkAt),
    editAt: atPrompt("tree", tree.editAt),
    run(name, args) {
      switch (name) {
        case "new":
          return go(name, fresh);
        case "resume":
          if (args && args !== "all") {
            notify("warning", "Use /resume, or /resume all for every project's sessions.");
            return true;
          }
          return go(name, () => resume(args === "all" ? "all" : "here"));
        case "fork":
          return go(name, fork);
        case "tree":
          return go(name, tree.open);
        case "clone":
          return go(name, clone);
        case "reload": {
          // As Pi's own /reload: replacing the extensions under a run or a compaction would pull them from under it.
          const work = busy();
          if (work) {
            notify(
              "warning",
              work === "run"
                ? "Wait for the current response to finish before reloading."
                : "Wait for compaction to finish before reloading.",
            );
            return true;
          }
          return go(name, async () => {
            await conversation.bridge({ kind: "reload" });
            reloadKeys();
            notify("info", "Reloaded Pi's extensions, skills, prompts, context files and keybindings");
          });
        }
        case "export":
          return go(name, async () => {
            const path = await conversation.exportHtml(args || undefined).catch((error: unknown) => {
              // Pi reports a folder that is not there as the file it could not open.
              throw args && /^ENOENT\b/.test(describe(error))
                ? new Error(`the folder ${dirname(args)}/ does not exist`)
                : error;
            });
            notify("info", "Exported this session to", path);
          });
      }
      if (!PI_SCREENS.some((command) => command.name === name)) return false;
      return go(name, () => screen(`/${name}${args ? ` ${args}` : ""}`));
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
