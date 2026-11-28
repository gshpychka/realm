import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type CursorKeys, latestStop, pressed, type Stop, stopId } from "./transcript-cursor.ts";

export interface CursorOptions {
  /** The keyboard walks the conversation, from its latest item. */
  browsing: boolean;
  stops: readonly Stop[];
  /** What each key does on each kind of stop. */
  keys: CursorKeys;
  scroll: RefObject<ScrollBoxRenderable | null>;
  /** Hands the keyboard back, as esc asks. */
  onLeave(): void;
  /** Draws entries from before the first stop, which up then moves on to; absent when there are none. */
  onEarlier?(): void;
}

/** What moves the cursor, and by how much. */
const MOVES = new Map([
  ["up", -1],
  ["down", 1],
]);

/** The stop `id` names among `stops`, or where the cursor starts when none does, as once its item goes. */
const find = (stops: readonly Stop[], id: string | null) =>
  stops.find((stop) => stopId(stop) === id) ?? latestStop(stops);

/** Moves up past the first stop, owed until the entries before it are drawn: those before `first`. */
interface Owed {
  by: number;
  first: string;
}

/**
 * The transcript cursor while `browsing`: the stop it has selected, from the latest, kept in
 * view as it moves and as the item changes size. The arrows move it, up past its first stop
 * onto the entries `onEarlier` draws, esc leaves, and any other key goes to the selected item's
 * keys. Each item's renderable carries its stop's id, and says through `resized` when it changes
 * size.
 */
export function useCursor({ browsing, stops, keys, scroll, onLeave, onEarlier }: CursorOptions) {
  const [chosen, setChosen] = useState<string | null>(null);
  // Keys that arrive together, faster than the screen redraws, each act where the move before
  // them landed, not where the last frame drew the cursor.
  const latest = useRef<string | null>(null);
  const owed = useRef<Owed | null>(null);
  const choose = (id: string | null) => {
    latest.current = id;
    setChosen(id);
  };
  // A selected item that changes size can change which of its keys apply, such as scrolling.
  const [, relaid] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (browsing) return;
    latest.current = null;
    owed.current = null;
    setChosen(null);
  }, [browsing]);
  const selected = browsing ? find(stops, chosen) : null;
  const selectedId = selected ? stopId(selected) : null;

  const reveal = useCallback((id: string) => scroll.current?.scrollChildIntoView(id), [scroll]);
  const picked = useRef(selectedId);
  picked.current = selectedId;
  // Layout settles only after the commit, so an item that changes size says so once it has.
  const resized = useCallback(
    (id: string) => {
      if (id !== picked.current) return;
      reveal(id);
      relaid();
    },
    [reveal],
  );
  useEffect(() => {
    if (selectedId) reveal(selectedId);
  }, [selectedId, reveal]);

  const listed = useRef(stops);
  listed.current = stops;
  const move = (by: number) => {
    const list = listed.current;
    const first = list[0];
    if (!first) return;
    const at = list.findIndex((stop) => stopId(stop) === latest.current);
    const from = at !== -1 ? at : list.indexOf(latestStop(list) ?? first);
    if (from + by < 0 && onEarlier) {
      owed.current = { by: (owed.current?.by ?? 0) + from + by, first: stopId(first) };
      choose(stopId(first));
      onEarlier();
      return;
    }
    const target = list[Math.max(0, Math.min(list.length - 1, from + by))];
    if (target) choose(stopId(target));
  };
  // Once entries before the first stop are drawn, the moves owed go on into them.
  useEffect(() => {
    const debt = owed.current;
    const first = stops[0];
    if (!debt || !first || stopId(first) === debt.first) return;
    owed.current = null;
    move(debt.by);
  });

  useKeyboard((key) => {
    if (!browsing) return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      onLeave();
      return;
    }
    const stop = find(listed.current, latest.current);
    if (key.ctrl || key.meta || !stop) return;
    const by = MOVES.get(key.name);
    const act = by === undefined ? pressed(keys, stop, key) : () => move(by);
    if (act) {
      key.preventDefault();
      act();
    } else if (key.name === "escape") {
      key.preventDefault();
      onLeave();
    }
  });

  return { selected, resized };
}
