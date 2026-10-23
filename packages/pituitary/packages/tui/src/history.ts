/**
 * Stepping back through earlier prompts from the editor.
 *
 * `index` is how far back the editor is showing, `null` while it shows the operator's
 * own draft, which is kept so stepping forward past the newest prompt brings it back.
 */
export interface Recall {
  index: number | null;
  draft: string;
}

export const fresh: Recall = { index: null, draft: "" };

/** Earlier prompts and `!` commands, oldest first, with repeats of the one before dropped. */
export function prompts(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) if (text.trim() && out.at(-1) !== text) out.push(text);
  return out;
}

/** One prompt further back, or `null` at the oldest. */
export function older(
  recall: Recall,
  entries: readonly string[],
  current: string,
): { recall: Recall; text: string } | null {
  const index = recall.index === null ? entries.length - 1 : recall.index - 1;
  const text = entries[index];
  if (text === undefined) return null;
  return { recall: { index, draft: recall.index === null ? current : recall.draft }, text };
}

/** One prompt forward, then the draft, or `null` when the draft is already showing. */
export function newer(recall: Recall, entries: readonly string[]): { recall: Recall; text: string } | null {
  if (recall.index === null) return null;
  const index = recall.index + 1;
  const text = entries[index];
  if (text === undefined) return { recall: fresh, text: recall.draft };
  return { recall: { ...recall, index }, text };
}
