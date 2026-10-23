import type { AssistantEntry, Entry, ToolView } from "@pituitary/session";
import { counted } from "./plural.ts";

/** One thing the model did on its way to a reply, in the order it did it. */
export type Step =
  | { kind: "thinking"; id: string; text: string }
  /** Words written before a tool call: narration of the work, not the reply. */
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolView };

/** The thinking, narration, and tool calls of consecutive replies, drawn together in one box. */
export interface Work {
  kind: "work";
  id: string;
  steps: Step[];
  /** The model is still working: the run goes on, and nothing has come after the box. */
  live: boolean;
}

/** What the model says to the operator once its work is done. */
export interface Reply {
  kind: "reply";
  id: string;
  text: string;
  streaming: boolean;
  /** Why the reply stopped short, when it did. */
  note?: string;
}

/** What the conversation draws: entries as they are, with each stretch of replies split into work and reply. */
export type Item = Exclude<Entry, AssistantEntry> | Work | Reply;

/** Stop reasons worth telling the operator about; the rest end a reply normally. */
const STOP_NOTE = new Map([["length", "the reply reached the output limit and stopped"]]);

/** `entries` as the conversation draws them, while a run goes on when `running`. */
export function transcriptOf(entries: readonly Entry[], running: boolean): Item[] {
  const items: Item[] = [];
  let stretch: AssistantEntry[] = [];
  const close = (live: boolean) => {
    items.push(...split(stretch, live));
    stretch = [];
  };
  for (const entry of entries) {
    if (entry.kind === "assistant") stretch.push(entry);
    else {
      close(false);
      items.push(entry);
    }
  }
  close(running);
  return items;
}

/**
 * A stretch of consecutive replies as one box of work and the reply after it. The last
 * reply's words are the reply unless it goes on to call a tool; every other word is narration.
 */
function split(stretch: readonly AssistantEntry[], running: boolean): Item[] {
  const last = stretch.at(-1);
  if (!last) return [];
  const answer = last.tools.length === 0 ? last : null;
  const steps = stretch.flatMap((entry): Step[] => [
    ...(entry.thinking
      ? [{ kind: "thinking", id: `${entry.id}:thinking`, text: entry.thinking } as const]
      : []),
    ...(entry.text && entry !== answer
      ? [{ kind: "text", id: `${entry.id}:text`, text: entry.text } as const]
      : []),
    ...entry.tools.map((tool) => ({ kind: "tool", id: tool.id, tool }) as const),
  ]);
  const items: Item[] = [];
  const first = steps[0];
  if (first) items.push({ kind: "work", id: first.id, steps, live: running && !(answer?.done ?? false) });
  const note = last.stopReason ? STOP_NOTE.get(last.stopReason) : undefined;
  if (answer?.text || note) {
    items.push({
      kind: "reply",
      id: last.id,
      text: answer?.text ?? "",
      streaming: !last.done,
      note,
    });
  }
  return items;
}

/** What a box of work comes to, such as `thought · 3 tools · 1 failed`. */
export function summary(work: Work): string {
  const thought = work.steps.some((step) => step.kind === "thinking");
  const tools = work.steps.flatMap((step) => (step.kind === "tool" ? [step.tool] : []));
  const failed = tools.filter((tool) => tool.state === "error").length;
  return [
    thought ? "thought" : null,
    tools.length > 0 ? counted(tools.length, "tool") : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Whether `entries` hold any work for a box: thinking, or a tool call. */
export function worked(entries: readonly Entry[]): boolean {
  return entries.some(
    (entry) => entry.kind === "assistant" && (entry.thinking !== "" || entry.tools.length > 0),
  );
}
