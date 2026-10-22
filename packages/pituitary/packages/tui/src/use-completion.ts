import type { KeyEvent } from "@opentui/core";
import { type RefObject, useEffect, useMemo, useState } from "react";
import { type Command, suggest } from "./commands/commands.ts";
import type { EditorHandle } from "./components/editor.tsx";
import type { Suggestion } from "./components/suggestions.tsx";
import { listFiles, mention, mentionAt, rank } from "./files.ts";

/** What the word being typed completes to, and what accepting one does. */
export interface Completion {
  items: Suggestion[];
  accept(index: number): void;
  /** Enter runs the command unless it needs an argument, and completes it then. */
  submits?: (index: number) => boolean;
}

/** A `/command` the draft starts to name. */
function commandsFor(text: string, commands: readonly Command[], editor: RefObject<EditorHandle | null>) {
  const named = suggest(text, commands);
  if (!named || named.length === 0) return null;
  return {
    items: named.map((each) => ({
      label: `/${each.name}${each.args ? ` ${each.args}` : ""}`,
      detail: each.description,
    })),
    accept: (at: number) => {
      const pick = named[at];
      if (pick) editor.current?.set(`/${pick.name} `);
    },
    submits: (at: number) => {
      const pick = named[at];
      return Boolean(pick && !pick.args?.startsWith("<"));
    },
  } satisfies Completion;
}

/** An `@path` the word at the cursor starts to name, from the files under `files`. */
function pathsFor(
  draft: { text: string; cursor: number },
  files: readonly string[],
  editor: RefObject<EditorHandle | null>,
): Completion | null {
  const at = mentionAt(draft.text, draft.cursor);
  if (!at) return null;
  const paths = rank(at.query, files);
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

/**
 * The list of what the draft could complete to, which follows the draft as it changes: a
 * command after `/`, a path after `@`. Escape closes it until the draft changes again.
 */
export function useCompletion(
  editor: RefObject<EditorHandle | null>,
  commands: readonly Command[],
  cwd: string,
) {
  const [draft, setDraft] = useState({ text: "", cursor: 0 });
  const [chosen, setChosen] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<{ cwd: string; paths: string[] }>({ cwd, paths: [] });
  const mentioning = mentionAt(draft.text, draft.cursor) !== null;

  // Scanning a large tree must not stop input or streaming. Refresh on each new mention,
  // so a file the agent just created is available without restarting the UI.
  useEffect(() => {
    if (!mentioning) return;
    let active = true;
    void listFiles(cwd).then((paths) => {
      if (active) setFiles({ cwd, paths });
    });
    return () => {
      active = false;
    };
  }, [cwd, mentioning]);

  const completion = useMemo<Completion | null>(() => {
    if (dismissed === draft.text) return null;
    return (
      commandsFor(draft.text, commands, editor) ??
      pathsFor(draft, files.cwd === cwd ? files.paths : [], editor)
    );
  }, [draft, commands, dismissed, cwd, editor, files]);
  const index = completion ? Math.min(chosen, completion.items.length - 1) : 0;

  return {
    completion,
    index,
    /** Takes the draft and cursor as they change; a new draft starts the list at its top. */
    follow(text: string, cursor: number) {
      setDraft((current) =>
        current.text === text && current.cursor === cursor ? current : { text, cursor },
      );
      setChosen(0);
    },
    /**
     * Takes the keys an open list answers: up and down choose, tab completes, enter completes
     * or runs the command through `run`, and `closing` closes the list. True when it took the key.
     */
    key(key: KeyEvent, closing: boolean, run: (name: string) => void): boolean {
      if (!completion) return false;
      const count = completion.items.length;
      const plain = !key.ctrl && !key.meta && !key.shift;
      if (plain && (key.name === "up" || key.name === "down"))
        setChosen((index + (key.name === "up" ? count - 1 : 1)) % count);
      else if (plain && key.name === "tab") completion.accept(index);
      else if (plain && (key.name === "return" || key.name === "kpenter")) choose(completion, index, run);
      else if (closing) setDismissed(draft.text);
      else return false;
      return true;
    },
  };
}

/** Runs the chosen command when choosing it runs it, and completes the draft with it otherwise. */
function choose(completion: Completion, index: number, run: (name: string) => void): void {
  if (completion.submits?.(index)) run(completion.items[index]?.label.split(" ")[0] ?? "");
  else completion.accept(index);
}
