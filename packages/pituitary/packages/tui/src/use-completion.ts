import type { KeyEvent } from "@opentui/core";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { type Command, suggest, typedName } from "./commands/commands.ts";
import type { DetailIcon } from "./components/detail.tsx";
import type { EditorHandle } from "./components/editor.tsx";
import type { Suggestion } from "./components/suggestions.tsx";
import { listFiles, mention, mentionAt, rank } from "./files.ts";
import { glyphs } from "./glyphs.ts";
import { theme } from "./theme.ts";

/** What the word being typed completes to, and what accepting one does. */
export interface Completion {
  items: Suggestion[];
  accept(index: number): void;
  /** The command enter runs on the item at `index`, as typed; null where enter completes it, as tab does. */
  runs?(index: number): string | null;
}

/** The mark a Pi command's row carries for its kind; Pituitary's own commands carry none. */
const KIND_ICONS: Partial<Record<Command["source"], DetailIcon>> = {
  skill: { glyph: glyphs.skill, colour: theme.skill },
  prompt: { glyph: glyphs.template, colour: null },
  extension: { glyph: glyphs.extension, colour: null },
};

/**
 * Whether enter runs `command` when `typed` names it. A half-typed name only completes, so
 * enter never runs the first of several matches, and a command that needs an argument, or a
 * skill, which is there to frame a request, always completes to take one.
 */
function runsOnEnter(command: Command, typed: string): boolean {
  return command.name === typed && command.source !== "skill" && !command.args?.startsWith("<");
}

/** A `/command` the draft starts to name. */
function commandsFor(text: string, commands: readonly Command[], editor: RefObject<EditorHandle | null>) {
  const named = suggest(text, commands);
  if (!named || named.length === 0) return null;
  const typed = typedName(text) ?? "";
  return {
    items: named.map((each) => ({
      label: `/${each.name}`,
      args: each.args,
      detail: each.description,
      icon: KIND_ICONS[each.source],
    })),
    accept: (at: number) => {
      const pick = named[at];
      if (pick) editor.current?.set(`/${pick.name} `);
    },
    runs: (at: number) => {
      const pick = named[at];
      return pick && runsOnEnter(pick, typed) ? `/${pick.name}` : null;
    },
  } satisfies Completion;
}

/** Paths a mention offers, which the list scrolls through. */
const MENTIONS = 50;

/** An `@path` the word at the cursor starts to name, from the files under `files`. */
function pathsFor(
  draft: { text: string; cursor: number },
  files: readonly string[],
  editor: RefObject<EditorHandle | null>,
): Completion | null {
  const at = mentionAt(draft.text, draft.cursor);
  if (!at) return null;
  const paths = rank(at.query, files, MENTIONS);
  if (paths.length === 0) return null;
  return {
    items: paths.map((path) => ({ label: mention(path) })),
    accept: (index) => {
      const path = paths[index];
      if (!path) return;
      const inserted = mention(path);
      const rest = draft.text.slice(at.end).replace(/^ /, "");
      editor.current?.set(
        `${draft.text.slice(0, at.start)}${inserted} ${rest}`,
        at.start + inserted.length + 1,
      );
    },
  };
}

/** Which way a key moves through an open list: shift+tab goes back, as up does. */
function stepOf(key: KeyEvent): -1 | 1 | null {
  if (key.ctrl || key.meta) return null;
  if (key.name === "tab" && key.shift) return -1;
  if (key.shift) return null;
  return key.name === "up" ? -1 : key.name === "down" ? 1 : null;
}

/**
 * The list of what the draft could complete to, which follows the draft as it changes: a
 * command after `/`, a path after `@`. Escape closes it until the draft changes again.
 */
export function useCompletion(
  editor: RefObject<EditorHandle | null>,
  commands: readonly Command[],
  cwd: string | null,
) {
  const [draft, setDraft] = useState({ text: "", cursor: 0 });
  const [chosen, setChosen] = useState(0);
  // Keys can arrive in a burst before React draws: each moves on from where the last left it.
  const choice = useRef(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<{ cwd: string | null; paths: string[] }>({ cwd, paths: [] });
  const mentioning = mentionAt(draft.text, draft.cursor) !== null;

  // Scanning a large tree must not stop input or streaming. Refresh on each new mention,
  // so a file the agent just created is available without restarting the UI.
  useEffect(() => {
    if (!mentioning || cwd === null) return;
    const scan = new AbortController();
    void listFiles(cwd, scan.signal).then((paths) => {
      if (!scan.signal.aborted) setFiles({ cwd, paths });
    });
    return () => scan.abort();
  }, [cwd, mentioning]);

  const completion = useMemo<Completion | null>(() => {
    if (dismissed === draft.text) return null;
    return (
      commandsFor(draft.text, commands, editor) ??
      (cwd === null ? null : pathsFor(draft, files.cwd === cwd ? files.paths : [], editor))
    );
  }, [draft, commands, dismissed, cwd, editor, files]);
  const index = completion ? Math.min(chosen, completion.items.length - 1) : 0;
  const choose = (next: number) => {
    choice.current = next;
    setChosen(next);
  };

  return {
    completion,
    index,
    /** The list as the popup draws it, with whether enter runs the chosen command; null while closed. */
    shown: completion ? { items: completion.items, index, runs: Boolean(completion.runs?.(index)) } : null,
    /** Takes the draft and cursor as they change; a new draft starts the list at its top. */
    follow(text: string, cursor: number) {
      setDraft((current) =>
        current.text === text && current.cursor === cursor ? current : { text, cursor },
      );
      choose(0);
    },
    /**
     * Takes the keys an open list answers: up and down choose, shift+tab as up does, tab
     * completes, enter runs a command named in full through `run` and completes anything
     * else, and `closing` closes the list. True when it took the key.
     */
    key(key: KeyEvent, closing: boolean, run: (command: string) => void): boolean {
      if (!completion) return false;
      const count = completion.items.length;
      const at = Math.min(choice.current, count - 1);
      const plain = !key.ctrl && !key.meta && !key.shift;
      const step = stepOf(key);
      if (step !== null) choose((at + step + count) % count);
      else if (plain && key.name === "tab") completion.accept(at);
      else if (plain && (key.name === "return" || key.name === "kpenter")) {
        const command = completion.runs?.(at);
        if (command) run(command);
        else completion.accept(at);
      } else if (closing) setDismissed(draft.text);
      else return false;
      return true;
    },
  };
}
