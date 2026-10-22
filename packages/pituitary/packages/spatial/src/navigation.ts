import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Coord, Heading } from "./coord.ts";
import type { Jumps, KeyMap } from "./keys.ts";
import { moveFor } from "./keys.ts";
import { type Lattice, type Pane, paneById } from "./lattice.ts";
import { arrived, position } from "./passage.ts";
import { pace, reach, type Standing, stand, walk } from "./standing.ts";
import { NO_PEEK, type Peek } from "./viewport.ts";
import { detailed, ease, FAR, NEAR, steady, to, toggle, type Zoom, zoom } from "./zoom.ts";

/** Milliseconds between easing steps, which sets how long a movement takes. */
const STEP_MS = 24;

export interface NavigationOptions {
  /** Pane to begin in, read once. Defaults to the first. */
  start?: string;
  /** Cells of the neighbouring pane left on screen. */
  peek?: Peek;
  /** Scale to begin at. */
  scale?: number;
  /** Key bindings, or false to bind none. */
  keys?: KeyMap | false;
  /**
   * Keys that go straight to a pane, by pane id.
   *
   * A walk only reaches panes the lattice puts side by side, so a pane standing on
   * its own is reachable this way alone.
   */
  jumps?: Jumps;
}

export interface Navigation {
  lattice: Lattice;
  /** The pane the operator is in, from the moment they set off. */
  focus: Pane;
  /** The surface's lattice position, fractional while moving. */
  at: Coord;
  zoom: Zoom;
  peek: Peek;
  /** True while the surface is moving or the scale is changing. */
  busy: boolean;
  /** True while the surface is close enough for panes to draw detail. */
  detailed: boolean;
  /** The heading under way, null at rest. */
  heading: Heading | null;
  /** The way back, which outlives the passage that made it. */
  back: Heading | null;
  go(heading: Heading): void;
  jump(id: string): void;
  widen(): void;
  close(): void;
  /** Widen if near, close if far. */
  toggleZoom(): void;
}

/**
 * Where the operator is on a lattice, and how close the surface is held.
 *
 * Two eased values on one clock. Both movements are plain values with a step
 * function, so this is the clock, the keys, and nothing else.
 */
export function useNavigation(of: Lattice, options: NavigationOptions = {}): Navigation {
  const { peek = NO_PEEK, keys, jumps } = options;

  const [standing, setStanding] = useState<Standing>(() => stand(firstOf(of, options.start)));
  const [held, setHeld] = useState<Zoom>(() => zoom(options.scale ?? NEAR));

  useEffect(() => {
    if (arrived(standing.passage)) return;
    const timer = setTimeout(() => setStanding(pace), STEP_MS);
    return () => clearTimeout(timer);
  }, [standing]);

  useEffect(() => {
    if (steady(held)) return;
    const timer = setTimeout(() => setHeld(ease), STEP_MS);
    return () => clearTimeout(timer);
  }, [held]);

  const go = useCallback((heading: Heading) => setStanding((from) => walk(of, from, heading)), [of]);
  const jump = useCallback((id: string) => setStanding((from) => reach(of, from, id)), [of]);
  const widen = useCallback(() => setHeld((current) => to(current, FAR)), []);
  const closeIn = useCallback(() => setHeld((current) => to(current, NEAR)), []);
  const toggleZoom = useCallback(() => setHeld(toggle), []);

  useKeyboard((key: KeyEvent) => {
    const move = moveFor(key.name ?? "", { keys, jumps });
    if (move === null) return;
    if ("walk" in move) go(move.walk);
    else if ("reach" in move) jump(move.reach);
    else if (move.scale === "widen") widen();
    else closeIn();
  });

  const focus = paneById(of, standing.here) ?? firstOf(of);

  return useMemo(
    () => ({
      lattice: of,
      focus,
      at: position(standing.passage),
      zoom: held,
      peek,
      busy: !arrived(standing.passage) || !steady(held),
      detailed: detailed(held),
      heading: standing.heading,
      back: standing.back,
      go,
      jump,
      widen,
      close: closeIn,
      toggleZoom,
    }),
    [of, focus, standing, held, peek, go, jump, widen, closeIn, toggleZoom],
  );
}

function firstOf(of: Lattice, id?: string): Pane {
  const found = (id ? paneById(of, id) : undefined) ?? of.panes[0];
  if (!found) throw new Error("a lattice needs at least one pane");
  return found;
}
