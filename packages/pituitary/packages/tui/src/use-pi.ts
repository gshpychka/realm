import type { UserEntry } from "@pituitary/session";
import { type RefObject, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { type Command, PI_SCREENS } from "./commands/commands.ts";
import type { EditorHandle } from "./components/editor.tsx";
import type { PickerSpec } from "./components/picker.tsx";
import type { PiControls, PiWorkspace } from "./pi.ts";
import type { SessionSummary } from "./pi-bridge.ts";
import { PI_EXTENSIONS } from "./pi-extensions.ts";
import { forkRows, sessionRows } from "./pi-sessions.ts";
import { tilde } from "./place.ts";
import type { Question } from "./use-ask.ts";
import type { SessionController } from "./use-session.ts";

export interface UsePiOptions {
  pi: PiControls | undefined;
  session: SessionController;
  editor: RefObject<EditorHandle | null>;
  pick(spec: PickerSpec): void;
  ask(question: Question): Promise<string | null>;
  flash(text: string): void;
  /** Hands the terminal to another program and takes it back. */
  terminal: { suspend(): void; resume(): void };
}

/** What the App does with regular Pi beyond the conversation. */
export interface Pi {
  workspace: PiWorkspace;
  /** Pi's extension, prompt-template and skill commands, without Pituitary's own bridge. */
  commands: Command[];
  /** Runs `/name args` when it is a session command or one of Pi's screens; false for anything else. */
  run(name: string, args: string): boolean;
  /** Forks a new session that ends before `prompt`, a prompt the transcript shows, its text into the draft. */
  forkFrom(prompt: UserEntry): void;
  /** Opens or closes the provider usage card, through Pituitary's usage extension. */
  toggleUsage(): void;
}

const subscribeNone = () => () => {};
const NO_WORKSPACE: PiWorkspace = { cwd: process.cwd(), commands: [] };

/**
 * Regular Pi's sessions run from Pituitary's own screen: new, fork, clone and resume replace
 * the session without remounting anything, so the draft and its undo history stay. Null for Dura.
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
  const commands = useMemo(
    () =>
      workspace.commands
        .filter((command) => command.name !== workspace.bridge)
        .map(
          (command): Command => ({
            name: command.name,
            description: command.description ?? "",
            source: command.source === "skill" ? "prompt" : command.source,
          }),
        ),
    [workspace],
  );
  const actions = pi ? sessionActions(pi, latest, { editor, pick, ask, flash, terminal }) : null;
  // `pituitary --resume` opens the picker once the session has loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the picker opens once, on the first snapshot
  useEffect(() => {
    if (resumed.current || !session.state || !pi?.resumeAtStart || !actions) return;
    resumed.current = true;
    actions.run("resume", "");
  }, [session.state, pi]);
  if (!pi || !actions) return null;
  const { conversation: link } = pi;
  return {
    workspace,
    commands,
    ...actions,
    toggleUsage: () => {
      const name = link.commandOf(PI_EXTENSIONS.usage);
      if (!name) session.notify("warning", "Pi has not loaded Pituitary's provider usage extension.");
      else void link.prompt(`/${name}`).catch((error) => session.notify("warning", describe(error)));
    },
  };
}

function sessionActions(
  pi: PiControls,
  latest: RefObject<SessionController>,
  { editor, pick, ask, flash, terminal }: Omit<UsePiOptions, "pi" | "session">,
): Pick<Pi, "run" | "forkFrom"> {
  const { conversation } = pi;
  const notify: SessionController["notify"] = (level, text) => latest.current.notify(level, text);
  const kept = () => notify("info", "An extension kept Pi on this session.");

  /** Puts `text` at the top of the draft, what was there below it, with the cursor at its end. */
  const intoDraft = (text: string) => {
    const draft = editor.current?.text() ?? "";
    editor.current?.set(draft.trim() ? `${text}\n\n${draft}` : text, text.length);
  };
  /**
   * Pi replaces a session only between runs. As Pi's own screen does, what is queued goes back
   * to the draft and the run stops first.
   */
  const settle = async () => {
    if (!latest.current.view.running) return;
    const queued = await latest.current.takeQueue();
    if (queued) intoDraft(queued);
    await conversation.abort();
  };

  const forkAt = async (entryId: string) => {
    await settle();
    const forked = await conversation.fork(entryId);
    if (!forked) return kept();
    if (forked.text) intoDraft(forked.text);
    notify("info", "Forked into a new session · editing your earlier prompt");
  };
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
    await settle();
    if (await conversation.clone()) notify("info", "Cloned this session into a new one");
    else kept();
  };
  const fresh = async () => {
    await settle();
    if (!(await conversation.newSession())) kept();
  };

  const resume = async (all: boolean, keep: { query?: string; selected?: string } = {}) => {
    const { sessions } = await conversation.bridge({ kind: "sessions", all });
    const current = latest.current.state?.sessionFile;
    const items = sessionRows(sessions, { current, all, now: Date.now() });
    if (!items.length)
      return notify(
        "info",
        all
          ? "Pi has no saved sessions."
          : "This project has no saved sessions yet. /resume all lists every project's.",
      );
    const label = (path: string) =>
      items.find((item) => item.value === path)?.label.replace(/^\s*└ /, "") ?? path;
    const again = (query: string, selected?: string) =>
      resume(all, { ...(query ? { query } : {}), ...(selected ? { selected } : {}) });
    pick({
      title: all ? "resume · every project's sessions" : "resume · this project's sessions",
      items,
      ...keep,
      keys: [
        {
          binding: "ctrl+r",
          label: "rename",
          run: (path, query) =>
            void (async () => {
              const name = await ask({
                method: "input",
                title: `Rename “${label(path)}”`,
                placeholder: label(path),
              });
              if (name?.trim())
                await conversation.bridge({ kind: "rename-session", path, name: name.trim() });
              await again(query, path);
            })().catch(failed("resume")),
        },
        {
          binding: "ctrl+x",
          label: "delete",
          run: (path, query) => {
            if (path === current) return flash("Pi has this session open, so it stays");
            void (async () => {
              const answer = await ask({
                method: "select",
                title: `Delete “${label(path)}”?\n${tilde(path)}`,
                options: ["Keep it", "Delete it"],
              });
              if (answer === "Delete it") await conversation.bridge({ kind: "delete-session", path });
              await again(query);
            })().catch(failed("resume"));
          },
        },
      ],
      onPick: (path) => {
        const target = sessions.find((each) => each.path === path);
        if (target) void open(target).catch(failed("resume"));
      },
    });
  };
  const open = async (target: SessionSummary) => {
    if (target.path === latest.current.state?.sessionFile) return flash("this is the session you are in");
    await settle();
    const from = conversation.workspace().cwd;
    if (!(await conversation.switchSession(target.path))) return kept();
    const to = conversation.workspace().cwd;
    if (to !== from) notify("info", `Working in ${tilde(to)}, where this session started`);
  };

  const screen = async (command: string) => {
    if (latest.current.view.running)
      return notify("warning", `${command} opens Pi's own screen once the run finishes or is interrupted.`);
    terminal.suspend();
    try {
      await pi.handoff(command);
    } finally {
      terminal.resume();
    }
    await latest.current.refresh();
  };

  const failed = (name: string) => (error: unknown) => notify("error", `/${name}: ${describe(error)}`);
  const go = (name: string, work: () => Promise<void>) => {
    void work().catch(failed(name));
    return true;
  };
  return {
    run(name, args) {
      switch (name) {
        case "new":
          return go(name, fresh);
        case "resume":
          if (args && args !== "all") {
            notify("warning", "Use /resume, or /resume all for every project's sessions.");
            return true;
          }
          return go(name, () => resume(args === "all"));
        case "fork":
          return go(name, fork);
        case "clone":
          return go(name, clone);
        case "reload":
          return go(name, async () => {
            await conversation.bridge({ kind: "reload" });
            notify("info", "Reloaded Pi's extensions, skills, prompts and context files");
          });
        case "export":
          return go(name, async () => {
            const path = await conversation.exportHtml(args || undefined);
            notify("info", `Exported this session to ${tilde(path)}`);
          });
      }
      if (!PI_SCREENS.some((command) => command.name === name)) return false;
      return go(name, () => screen(`/${name}${args ? ` ${args}` : ""}`));
    },
    forkFrom(prompt) {
      void (async () => {
        const target = (await conversation.branchPrompts()).find((each) => each.place === prompt.place);
        if (!target) return notify("warning", "That prompt is not on this session's current branch.");
        await forkAt(target.entryId);
      })().catch(failed("fork"));
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
