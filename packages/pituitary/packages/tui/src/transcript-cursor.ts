import type { BashEntry, CustomEntry, NoticeEntry, SummaryEntry, UserEntry } from "@pituitary/session";
import { isOpinion, type OpinionEntry } from "./consult/consult.ts";
import type { LiveConsult } from "./consult/consults.ts";
import { type Hint, MOVE } from "./hints.ts";
import { type KeyLike, matches } from "./keymap.ts";
import type { Item, Reply, Work } from "./transcript.ts";

/**
 * What the transcript cursor stops on, by kind: every item the conversation draws but a turn's
 * figures, which say nothing of their own to act on, and the cards of second opinions under way
 * after them.
 */
export interface Stops {
  work: Work;
  prompt: UserEntry;
  reply: Reply;
  shell: BashEntry;
  summary: SummaryEntry;
  notice: NoticeEntry | CustomEntry;
  opinion: OpinionEntry;
  consult: LiveConsult;
}

export type StopKind = keyof Stops;

/** An item the cursor can select, with the kind its keys are looked up by. */
export type Stop = { [K in StopKind]: { kind: K; item: Stops[K] } }[StopKind];

/** The stops among `items`, in the order the conversation draws them, then the `consults` drawn after them. */
export function stopsOf(items: readonly Item[], consults: readonly LiveConsult[] = []): Stop[] {
  const drawn = items.flatMap((item): Stop[] => {
    switch (item.kind) {
      case "work":
        return [{ kind: "work", item }];
      case "user":
        return [{ kind: "prompt", item }];
      case "reply":
        return [{ kind: "reply", item }];
      case "bash":
        return [{ kind: "shell", item }];
      case "summary":
        return [{ kind: "summary", item }];
      case "custom":
        return [isOpinion(item) ? { kind: "opinion", item } : { kind: "notice", item }];
      case "notice":
        return [{ kind: "notice", item }];
      case "turn":
        return [];
      default:
        return item satisfies never;
    }
  });
  return [...drawn, ...consults.map((item): Stop => ({ kind: "consult", item }))];
}

/** Which stop `stop` is, unique among a conversation's stops. */
export const stopId = (stop: Stop) => `${stop.kind}:${stop.item.id}`;

/**
 * Where the cursor starts among `stops`: the conversation's latest item. The cards of second
 * opinions under way come after it, a move down, so a cursor opened to go back to the
 * conversation does not start on one.
 */
export const latestStop = (stops: readonly Stop[]): Stop | null =>
  stops.findLast((stop) => stop.kind !== "consult") ?? stops.at(-1) ?? null;

/** A key the cursor answers on one kind of stop. */
export interface CursorKey<T> {
  /** The keys, as bindings name them, such as `c` or `enter`. */
  keys: readonly string[];
  /** How the hint line names the keys, when not by the first of them. */
  label?: string;
  /** What the key does to `item`, as the hint line words it: `open`, or `close` for a box that is. */
  does(item: T): string;
  /** Whether the key does anything to `item`; the hint line leaves it out when not. */
  applies?(item: T): boolean;
  /** Does it; `key` is which of `keys` was pressed. */
  run(item: T, key: string): void;
}

/**
 * What the cursor's keys do on each kind of stop. The conversation brings the keys that change
 * how an item shows; the App brings what acts on it, such as copying or forking from it.
 */
export type CursorKeys = { [K in StopKind]?: readonly CursorKey<Stops[K]>[] };

/** The keys of each table, kind by kind, the first table's first. */
export function joinKeys(...tables: readonly CursorKeys[]): CursorKeys {
  const joined: Record<string, readonly CursorKey<never>[]> = {};
  for (const table of tables)
    for (const [kind, keys] of Object.entries(table))
      joined[kind] = [...(joined[kind] ?? []), ...(keys ?? [])];
  return joined as CursorKeys;
}

/** A key that applies to the stop under the cursor, its item bound in. */
interface Bound {
  keys: readonly string[];
  hint: Hint;
  run(key: string): void;
}

/** The keys that apply to `stop`, in the table's order. */
function keysFor<K extends StopKind>(table: CursorKeys, stop: { kind: K; item: Stops[K] }): Bound[] {
  // Each kind's keys take that kind's items, which the table's type holds kind by kind.
  const keys = (table[stop.kind] ?? []) as readonly CursorKey<Stops[K]>[];
  return keys
    .filter((key) => key.applies?.(stop.item) ?? true)
    .map((key) => ({
      keys: key.keys,
      hint: [key.label ?? key.keys[0] ?? "", key.does(stop.item)],
      run: (pressed: string) => key.run(stop.item, pressed),
    }));
}

/** What `key` does on `stop`, or null when no key that applies to it is `key`. */
export function pressed(table: CursorKeys, stop: Stop, key: KeyLike): (() => void) | null {
  for (const each of keysFor(table, stop)) {
    const binding = each.keys.find((name) => matches(key, name));
    if (binding) return () => each.run(binding);
  }
  return null;
}

/** The hint line's keys while the cursor rests on `stop`: moving, what applies to it, and leaving. */
export function cursorHints(table: CursorKeys, stop: Stop | null, leave: string): Hint[] {
  const own = stop ? keysFor(table, stop) : [];
  return [MOVE, ...own.map((each) => each.hint), [leave, "back"]];
}
