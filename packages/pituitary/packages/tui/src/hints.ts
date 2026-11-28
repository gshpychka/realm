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

/** Enter on a list's highlighted row. */
export const PICK: Hint = ["enter", "pick"];

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
const SPARED: readonly Hint[] = [MOVE, PAGE, PICK];

/**
 * A popup's hint line: its keys in order, then where the list stands, in `columns`. A key the
 * operator unbound, given as null, is left out. The count keeps its cells whatever the keys
 * need. Keys that do not fit beside it lose the moving, paging and picking keys first, so a
 * list's own keys and the key that dismisses it stay; only then do keys drop from the end,
 * whole, and a first key too long alone is cut at its end.
 */
export function hintLine(hints: readonly (Hint | null)[], count: string | null, columns: number): string {
  let kept = hints.filter((hint) => hint !== null);
  const keys = () => kept.map(([keys, does]) => `${keys} ${does}`).join(" · ");
  const room = count ? columns - Bun.stringWidth(` · ${count}`) : columns;
  for (const spared of SPARED) {
    if (Bun.stringWidth(keys()) <= room) break;
    kept = kept.filter((hint) => hint !== spared);
  }
  while (kept.length > 1 && Bun.stringWidth(keys()) > room) kept = kept.slice(0, -1);
  if (!count) return ellipsize(keys(), columns);
  return kept.length > 0 && room > 0 ? `${ellipsize(keys(), room)} · ${count}` : ellipsize(count, columns);
}

/** The dismissing key's hint, when the operator has one bound. */
export function dismiss(key: string | null, does: "close" | "cancel"): Hint | null {
  return key ? [key, does] : null;
}
