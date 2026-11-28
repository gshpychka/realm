import type { BashEntry, UserEntry } from "@pituitary/session";
import type { OpinionEntry } from "./consult/consult.ts";
import { failed, type LiveConsult, stoppable } from "./consult/consults.ts";
import type { Consult } from "./consult/use-consult.ts";
import { type Reply, workText } from "./transcript.ts";
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
  /**
   * Regular Pi's second opinions: asking about a reply, acting on an opinion, and cancelling or
   * copying one under way. None in Dura.
   */
  consult?: Pick<Consult, "weighIn" | "address" | "reply" | "cancel" | "textOf">;
  /** Hands the keyboard back to the draft, which going back to a prompt fills. */
  leave(): void;
}

/**
 * What the cursor's keys do to an item beyond how it shows: `c` copies any of them as text, and
 * on a prompt regular Pi's `f` forks a new session from before it and `e` edits it in place.
 * Both need the prompt's own entry in Pi's session, which a prompt keyed by its message has.
 * Regular Pi's `w` asks other models to weigh in on a reply; on a second opinion, `a` asks the
 * agent to address it and `r` replies to the model that gave it; on a second opinion's card,
 * `x` cancels it while it answers, or clears it once it failed, and `c` copies what it says.
 * Esc leaves the cursor wherever it is, so pressing it again and again stops nothing.
 */
export function actingKeys({ copy, prompts, consult, leave }: ActingOptions): CursorKeys {
  /** `c`, which copies an item as `text` words it, saying it copied `what`. */
  const copies = <T>(what: string | ((item: T) => string), text: (item: T) => string): CursorKey<T> => ({
    keys: ["c"],
    does: () => "copy",
    // A reply that is only why it stopped, such as an interruption, has no words to copy.
    applies: (item) => text(item) !== "",
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
    reply: [
      ...(consult
        ? [
            // The list of models takes the keyboard from the cursor, as the reply's question does for `r`.
            {
              keys: ["w"],
              does: () => "weigh in",
              applies: (reply: Reply) => reply.text !== "",
              run: (reply: Reply) => consult.weighIn(reply),
            },
          ]
        : []),
      copies("the reply", (reply) => reply.text),
    ],
    opinion: [
      ...(consult
        ? [
            {
              keys: ["a"],
              does: () => "address",
              run: (entry: OpinionEntry) => {
                leave();
                consult.address(entry.details);
              },
            },
            { keys: ["r"], does: () => "reply", run: (entry: OpinionEntry) => consult.reply(entry.details) },
          ]
        : []),
      copies("the opinion", (entry) => entry.details.answer),
    ],
    consult: consult
      ? [
          {
            keys: ["x"],
            does: (card) => (failed(card) ? "clear" : "cancel"),
            // An answer going into the record joins the conversation however its card goes.
            applies: (card) => stoppable(card) || failed(card),
            run: (card) => consult.cancel(card.id),
          },
          {
            keys: ["c"],
            does: () => "copy",
            applies: (card: LiveConsult) => card.round !== undefined || card.error !== undefined,
            run: (card) => void consult.textOf(card).then((text) => copy(text, "the second opinion so far")),
          },
        ]
      : [],
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
