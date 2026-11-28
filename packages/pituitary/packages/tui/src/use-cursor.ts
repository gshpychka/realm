import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type CursorKeys, pressed, type Stop, stopId } from "./transcript-cursor.ts";

export interface CursorOptions {
  /** The keyboard walks the conversation, from its latest item. */
  browsing: boolean;
  stops: readonly Stop[];
  /** What each key does on each kind of stop. */
  keys: CursorKeys;
  scroll: RefObject<ScrollBoxRenderable | null>;
  /** Hands the keyboard back, as esc asks. */
  onLeave(): void;
}

/** What moves the cursor, and by how much. */
const MOVES = new Map([
  ["up", -1],
  ["down", 1],
]);

/**
 * The transcript cursor while `browsing`: the stop it has selected, from the latest, kept in
 * view as it moves and as the item changes size. The arrows move it, esc leaves, and any other
 * key goes to the selected item's keys. Each item's renderable carries its stop's id, and says
 * through `resized` when it changes size.
 */
export function useCursor({ browsing, stops, keys, scroll, onLeave }: CursorOptions) {
  const [chosen, setChosen] = useState<string | null>(null);
  // A selected item that changes size can change which of its keys apply, such as scrolling.
  const [, relaid] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!browsing) setChosen(null);
  }, [browsing]);
  const selected = browsing ? (stops.find((stop) => stopId(stop) === chosen) ?? stops.at(-1) ?? null) : null;
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

  // Arrows pressed faster than the screen redraws each move from where the one before landed.
  const listed = useRef(stops);
  listed.current = stops;
  const move = (by: number) =>
    setChosen((from) => {
      const list = listed.current;
      const at = list.findIndex((stop) => stopId(stop) === from);
      const index = Math.max(0, Math.min(list.length - 1, (at === -1 ? list.length - 1 : at) + by));
      const target = list[index];
      return target ? stopId(target) : from;
    });

  useKeyboard((key) => {
    if (!browsing) return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      onLeave();
      return;
    }
    if (key.ctrl || key.meta || !selected) return;
    const by = MOVES.get(key.name);
    const act = by === undefined ? pressed(keys, selected, key) : () => move(by);
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
