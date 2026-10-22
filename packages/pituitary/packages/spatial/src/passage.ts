import { type Coord, same } from "./coord.ts";
import { approach, settled } from "./ease.ts";

/**
 * The surface's passage from one position to another.
 *
 * Progress of exactly one means arrived, and arrival puts the surface exactly on the
 * destination: no state has it arrived and between positions at once.
 */
export interface Passage {
  from: Coord;
  to: Coord;
  /** Zero at departure, exactly one on arrival. */
  progress: number;
}

export function resting(at: Coord): Passage {
  return { from: at, to: at, progress: 1 };
}

/** A new passage to `to`, starting from wherever the surface has got to. */
export function depart(current: Passage, to: Coord): Passage {
  const from = position(current);
  return same(from, to) ? resting(to) : { from, to, progress: 0 };
}

/** The surface's lattice position, interpolated across the passage. */
export function position(current: Passage): Coord {
  const { from, to, progress } = current;
  return [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress];
}

export function arrived(current: Passage): boolean {
  return settled(current.progress, 1);
}

/** One step of easing. Advancing an arrived passage changes nothing. */
export function advance(current: Passage): Passage {
  return arrived(current) ? current : { ...current, progress: approach(current.progress, 1) };
}
