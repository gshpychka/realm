import type { UserEntry } from "@pituitary/session";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { EditorHandle } from "./components/editor.tsx";
import type { PickerSpec } from "./components/picker.tsx";
import type { PiConversation } from "./pi.ts";
import type { TreeNode } from "./pi-bridge.ts";
import { firstLine } from "./pi-sessions.ts";
import { treeRows } from "./pi-tree.ts";
import type { Question } from "./use-ask.ts";
import type { SessionController } from "./use-session.ts";

/** The answers to whether a move summarizes the branch it leaves, as Pi's own tree words them. */
const SUMMARY_CHOICES = ["No summary", "Summarize", "Summarize with custom prompt"] as const;
const [NO_SUMMARY, , CUSTOM_SUMMARY] = SUMMARY_CHOICES;

export interface NavigationOptions {
  conversation: PiConversation;
  /** The App's list: a spec opens one, null closes it, and an update can open one only where none is. */
  pick: Dispatch<SetStateAction<PickerSpec | null>>;
  ask(question: Question): Promise<string | null>;
  flash(text: string): void;
  notify: SessionController["notify"];
  editor: RefObject<EditorHandle | null>;
  /** Stops a run or compaction first, as Pi does before a move, and gives back what was queued. */
  settle(): Promise<string>;
  /** Puts `text` at the top of the draft, what was there below it. */
  intoDraft(text: string): void;
  /** Says a move is summarizing the branch it leaves, with what stops it; null once it is done. */
  summarizing(stop: (() => void) | null): void;
}

/** Where the tree list opens again after a key's work or a cancelled move: its entry, and the filter. */
type Keep = { selected?: string; query?: string };

/**
 * Pi's `/tree` on Pituitary's own screen. The list shows every branch of the session, and
 * picking an entry moves the session there, after asking, unless Pi's settings skip it,
 * whether to summarize the branch it leaves. A prompt, or an extension's message, is moved
 * before and written again in the draft; the session stays mounted, as with a fork.
 */
export function treeNavigation({
  conversation,
  pick,
  ask,
  flash,
  notify,
  editor,
  settle,
  intoDraft,
  summarizing,
}: NavigationOptions) {
  const failed = (error: unknown) =>
    notify("error", `/tree: ${error instanceof Error ? error.message : String(error)}`);

  /**
   * The list, opened afresh; `again` marks it coming back after a key's work or a cancelled
   * move, which stays shut when another list opened meanwhile.
   */
  const open = async (keep: Keep = {}, again = false): Promise<void> => {
    const { nodes, leaf, skipSummaryPrompt } = await conversation.bridge({ kind: "tree" });
    const { items, here } = treeRows(nodes, leaf, Date.now());
    if (!items.length) return notify("info", "This session has no entries to move to yet.");
    const spec: PickerSpec = {
      title: "tree · move to another point of this session",
      items,
      ...keep,
      keys: [
        {
          action: "app.tree.editLabel",
          label: "label",
          run: (entryId, query) => {
            // The list shuts while the label is asked for, and comes back on the same entry.
            pick(null);
            void relabel(nodes, entryId)
              .then(() => open({ selected: entryId, query }, true))
              .catch(failed);
          },
        },
      ],
      onPick: (entryId) => {
        if (entryId === here) return flash("the session is already here");
        // Backing out of a question about the move, or stopping its summary, comes back to the
        // list on the entry, as in Pi.
        void move(entryId, skipSummaryPrompt, () => open({ selected: entryId }, true)).catch(failed);
      },
    };
    pick(again ? (shown) => shown ?? spec : spec);
  };

  const relabel = async (nodes: readonly TreeNode[], entryId: string) => {
    const node = nodes.find((each) => each.id === entryId);
    const label = await ask({
      method: "input",
      title: `Label “${firstLine(node?.text ?? "") || "this entry"}” · an empty label takes it off`,
      placeholder: node?.label ?? "a label to find this point by",
    });
    if (label !== null) await conversation.bridge({ kind: "label", entryId, label });
  };

  /** Whether to summarize the branch a move leaves, and how; null when the operator backs out. */
  const summary = async (): Promise<{ summarize: boolean; instructions?: string } | null> => {
    for (;;) {
      const choice = await ask({
        method: "select",
        title: "Summarize the branch you leave?",
        options: [...SUMMARY_CHOICES],
      });
      if (choice === null) return null;
      if (choice !== CUSTOM_SUMMARY) return { summarize: choice !== NO_SUMMARY };
      const instructions = await ask({
        method: "editor",
        title: "Instructions for the summary",
        prefill: "",
      });
      // Backing out of the instructions asks again, as in Pi.
      if (instructions !== null) return { summarize: true, instructions };
    }
  };

  /** Moves the session to `entryId`; `back` runs when the operator backs out or stops the summary. */
  const move = async (entryId: string, skipSummaryPrompt: boolean, back?: () => Promise<void>) => {
    const chosen = skipSummaryPrompt ? { summarize: false } : await summary();
    if (!chosen) return back?.();
    const queued = await settle();
    const draft = editor.current?.text() ?? "";
    let stopped = false;
    if (chosen.summarize)
      summarizing(() => {
        stopped = true;
        void conversation.abort().catch(failed);
      });
    let moved: { text: string } | null;
    try {
      moved = await conversation.navigate({ entryId, ...chosen });
    } finally {
      if (chosen.summarize) summarizing(null);
    }
    if (!moved) {
      if (queued) intoDraft(queued);
      if (!stopped) return notify("info", "An extension kept the session where it was.");
      flash("stopped summarizing · the session stays where it was");
      return back?.();
    }
    if (!moved.text) {
      if (queued) intoDraft(queued);
      return notify("info", "Moved to that point of the session");
    }
    // As a fork does, the prompt replaces the draft, which nvim's undo keeps; the queue taken
    // back from the run stays under it.
    editor.current?.set([moved.text, queued].filter(Boolean).join("\n\n"), moved.text.length);
    notify(
      "info",
      `Back before that prompt · editing it in the draft${draft.trim() ? " · esc u brings your draft back" : ""}`,
    );
  };

  return {
    /** Opens the tree list. */
    open: () => open(),
    /** Moves back before the prompt the transcript shows as `prompt`, which goes into the draft. */
    editAt: async (prompt: UserEntry) => {
      const found =
        prompt.key && (await conversation.branchPrompts()).find((each) => each.key === prompt.key);
      if (!found) return notify("info", "That prompt is not on the branch the session is on.");
      const { skipSummaryPrompt } = await conversation.bridge({ kind: "tree" });
      await move(found.entryId, skipSummaryPrompt);
    },
  };
}
