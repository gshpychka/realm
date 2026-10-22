import { type Heading, OPPOSITE } from "./coord.ts";
import { type Lattice, neighbour, type Placed, paneById } from "./lattice.ts";
import { advance, arrived, depart, type Passage, resting } from "./passage.ts";

/**
 * Where the operator stands on a lattice, and the movement still catching up.
 *
 * The pane is entered the moment they set off, so a cue reads the destination while
 * the passage to it is still visible.
 */
export interface Standing {
  /** Id of the pane the operator is in. */
  here: string;
  passage: Passage;
  /** The heading under way, null at rest. */
  heading: Heading | null;
  /** The way back, which outlives the passage that made it. */
  back: Heading | null;
}

export function stand(at: Placed): Standing {
  return { here: at.id, passage: resting(at.at), heading: null, back: null };
}

/**
 * One pace of the movement under way.
 *
 * The heading clears on arrival, in the same step that lands the position, so no
 * state is arrived and under way at once.
 */
export function pace(current: Standing): Standing {
  if (arrived(current.passage)) return current;
  const passage = advance(current.passage);
  return { ...current, passage, heading: arrived(passage) ? null : current.heading };
}

/** One step's walk, where the lattice puts something that way. */
export function walk(of: Lattice<Placed>, current: Standing, heading: Heading): Standing {
  const from = paneById(of, current.here);
  const next = from && neighbour(of, from, heading);
  return next ? enter(current, next, heading) : current;
}

/** Straight to a pane, however far off the lattice puts it. */
export function reach(of: Lattice<Placed>, current: Standing, id: string): Standing {
  const next = paneById(of, id);
  return next && next.id !== current.here ? enter(current, next, null) : current;
}

function enter(current: Standing, to: Placed, via: Heading | null): Standing {
  return {
    here: to.id,
    passage: depart(current.passage, to.at),
    heading: via,
    back: via === null ? null : OPPOSITE[via],
  };
}
