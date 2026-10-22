import type { Heading } from "./coord.ts";

/** Keys bound by default. Pass `keys: false` where a pane owns the keyboard. */
export const DEFAULT_KEYS = {
  west: ["left", "h"],
  east: ["right", "l"],
  north: ["up", "k"],
  south: ["down", "j"],
  widen: ["-", "z"],
  close: ["+", "=", "return"],
} as const;

/** Bindings to lay over the defaults, one action at a time. */
export type KeyMap = { [K in keyof typeof DEFAULT_KEYS]?: readonly string[] };

/** Keys that go straight to a pane, by pane id. */
export type Jumps = Readonly<Record<string, string>>;

/** What a key does. */
export type Move = { walk: Heading } | { scale: "widen" | "close" } | { reach: string };

export interface Bindings {
  keys?: KeyMap | false;
  jumps?: Jumps;
}

/**
 * The move a key makes, or null where it is bound to nothing.
 *
 * A jump is looked up first, so a caller can send a key the defaults claim straight
 * to a pane instead. `keys: false` leaves the jumps standing: each is bound by the
 * caller naming it, so neither turns the other off.
 */
export function moveFor(name: string, bindings: Bindings = {}): Move | null {
  const { keys = DEFAULT_KEYS, jumps = {} } = bindings;
  const reach = jumps[name];
  if (reach !== undefined) return { reach };
  if (keys === false) return null;
  const bound = { ...DEFAULT_KEYS, ...keys };
  if (bound.west.includes(name)) return { walk: "west" };
  if (bound.east.includes(name)) return { walk: "east" };
  if (bound.north.includes(name)) return { walk: "north" };
  if (bound.south.includes(name)) return { walk: "south" };
  if (bound.widen.includes(name)) return { scale: "widen" };
  if (bound.close.includes(name)) return { scale: "close" };
  return null;
}
