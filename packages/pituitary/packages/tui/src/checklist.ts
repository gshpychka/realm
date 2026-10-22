/**
 * Which items of a list are checked, in order. `null` checks every item; a list that covers
 * every item collapses back to `null`, as pi's own model scope does.
 */
export type Checked = readonly string[] | null;

export function isChecked(checked: Checked, value: string): boolean {
  return checked === null || checked.includes(value);
}

function collapse(checked: readonly string[], all: readonly string[]): Checked {
  return checked.length === all.length && checked.every((value) => all.includes(value)) ? null : checked;
}

export function toggle(checked: Checked, all: readonly string[], value: string): Checked {
  if (checked === null) return all.filter((each) => each !== value);
  if (checked.includes(value)) return checked.filter((each) => each !== value);
  return collapse([...checked, value], all);
}

/** Checks each of `targets`, every item when absent. */
export function checkAll(
  checked: Checked,
  all: readonly string[],
  targets: readonly string[] = all,
): Checked {
  if (checked === null) return null;
  return collapse([...checked, ...targets.filter((value) => !checked.includes(value))], all);
}

/** Clears each of `targets`, every item when absent. */
export function clearAll(checked: Checked, all: readonly string[], targets?: readonly string[]): Checked {
  if (!targets) return [];
  return (checked ?? all).filter((value) => !targets.includes(value));
}

/** Moves `value` one place along the checked order; `delta` is -1 or 1. */
export function reorder(checked: Checked, value: string, delta: -1 | 1): Checked {
  if (checked === null) return null;
  const from = checked.indexOf(value);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= checked.length) return checked;
  const moved = [...checked];
  [moved[from], moved[to]] = [moved[to] as string, moved[from] as string];
  return moved;
}

/** The checked items in their order, then the rest in list order. */
export function ordered(checked: Checked, all: readonly string[]): string[] {
  if (checked === null) return [...all];
  return [...checked, ...all.filter((value) => !checked.includes(value))];
}
