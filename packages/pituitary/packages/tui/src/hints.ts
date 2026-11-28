import { ellipsize } from "./text-width.ts";

/**
 * A key and what it does, as a popup's hint line names it: `↑↓ move`, `enter pick`.
 *
 * Every popup words the same keys alike: the arrows move, enter names what it does with the
 * highlighted row, and the dismissing key closes a list or cancels a question, which then
 * answers as cancelled.
 */
export type Hint = readonly [keys: string, does: string];

export const MOVE: Hint = ["↑↓", "move"];

/** The paging keys, which scroll a long question or panel. */
export const PAGE: Hint = ["pgup pgdn", "scroll"];

/** The mark beside a list's highlighted row; a folded box of work keeps `▸` to itself. */
export const SELECTED = "▶ ";
/** The same cells beside every other row. */
export const UNSELECTED = "  ";

/**
 * The words after the item in effect now, such as the current model or the task this
 * conversation is attached to, which say so without relying on colour. A word, since `✓`
 * already reads as a passed check and `▶` as the highlighted row.
 */
export const CURRENT = " · current";

/** Where the highlighted row stands in a list, as the end of its hint line reads. */
export function position(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

/** Hints every list reads alike, which a narrow line leaves out first, in this order. */
const SPARED: readonly Hint[] = [MOVE, PAGE];

/**
 * A popup's hint line: its keys in order, then where the list stands, in `columns`. A key the
 * operator unbound, given as null, is left out. A line too long for its columns drops the
 * moving and paging keys before anything else, so the key that dismisses it and the count
 * stay; only then is it cut at the end.
 */
export function hintLine(hints: readonly (Hint | null)[], count: string | null, columns: number): string {
  let kept = hints.filter((hint) => hint !== null);
  const line = () =>
    [...kept.map(([keys, does]) => `${keys} ${does}`), ...(count ? [count] : [])].join(" · ");
  for (const spared of SPARED) {
    if (Bun.stringWidth(line()) <= columns) break;
    kept = kept.filter((hint) => hint !== spared);
  }
  return ellipsize(line(), columns);
}

/** The dismissing key's hint, when the operator has one bound. */
export function dismiss(key: string | null, does: "close" | "cancel"): Hint | null {
  return key ? [key, does] : null;
}
