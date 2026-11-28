import type { BashEntry, UserEntry } from "@pituitary/session";
import { workText } from "./transcript.ts";
import type { CursorKey, CursorKeys } from "./transcript-cursor.ts";
import type { Pi } from "./use-pi.ts";
import { typed } from "./user-text.ts";

export interface ActingOptions {
  /** Puts `text` on the clipboard, saying it copied `what`. */
  copy(text: string, what: string): void;
  /**
   * Regular Pi's ways back to an earlier prompt, each bringing its text into the draft: a new
   * session from before it, or this one moved back before it. None in Dura.
   */
  prompts?: Pick<Pi, "forkAt" | "editAt">;
  /** Hands the keyboard back to the draft, which going back to a prompt fills. */
  leave(): void;
}

/**
 * What the cursor's keys do to an item beyond how it shows: `c` copies any of them as text, and
 * on a prompt regular Pi's `f` forks a new session from before it and `e` edits it in place.
 * Both need the prompt's own entry in Pi's session, which a prompt keyed by its message has.
 */
export function actingKeys({ copy, prompts, leave }: ActingOptions): CursorKeys {
  /** `c`, which copies an item as `text` words it, saying it copied `what`. */
  const copies = <T>(what: string | ((item: T) => string), text: (item: T) => string): CursorKey<T> => ({
    keys: ["c"],
    does: () => "copy",
    run: (item) => copy(text(item), typeof what === "string" ? what : what(item)),
  });
  const recorded = (prompt: UserEntry) => prompt.key !== undefined;
  const back = (to: (prompt: UserEntry) => void) => (prompt: UserEntry) => {
    leave();
    to(prompt);
  };
  const shell = (entry: BashEntry) =>
    [`$ ${entry.command}`, entry.output.trimEnd()].filter(Boolean).join("\n");
  return {
    work: [copies("the box's steps", workText)],
    prompt: [
      ...(prompts
        ? [
            { keys: ["f"], does: () => "fork", applies: recorded, run: back(prompts.forkAt) },
            { keys: ["e"], does: () => "edit", applies: recorded, run: back(prompts.editAt) },
          ]
        : []),
      copies("the prompt", (prompt) => typed(prompt.text)),
    ],
    reply: [copies("the reply", (reply) => reply.text)],
    shell: [copies("the command and its output", shell)],
    summary: [copies("the summary", (summary) => summary.text)],
    notice: [
      copies(
        (item) => (item.kind === "custom" ? "the message" : "the notice"),
        (item) => item.text,
      ),
    ],
  };
}
