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

/** Where the highlighted row stands in a list, as the end of its hint line reads. */
export function position(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

/**
 * A popup's hint line: its keys in order, then where the list stands, cut at the end to
 * `columns`. A key the operator unbound, given as null, is left out.
 */
export function hintLine(hints: readonly (Hint | null)[], count: string | null, columns: number): string {
  const said = hints.flatMap((hint) => (hint ? [`${hint[0]} ${hint[1]}`] : []));
  return ellipsize([...said, ...(count ? [count] : [])].join(" · "), columns);
}

/** The dismissing key's hint, when the operator has one bound. */
export function dismiss(key: string | null, does: "close" | "cancel"): Hint | null {
  return key ? [key, does] : null;
}
