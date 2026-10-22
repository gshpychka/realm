import type { ReactNode } from "react";
import {
  bearing,
  type Cells,
  type Coord,
  type Extent,
  extentOf,
  HEADINGS,
  type Heading,
  same,
  spanOf,
  step,
} from "./coord.ts";

/** What a pane is told when it renders. */
export interface PaneView {
  /** Cells the pane occupies, which shrink as the surface widens out. */
  size: Cells;
  /** True for the pane the operator is in. */
  focused: boolean;
  /** True while the surface is close enough for detail to be worth drawing. */
  detailed: boolean;
}

/** Something occupying a lattice position. */
export interface Placed {
  id: string;
  at: Coord;
  /** A label, used by anything that names places. */
  name?: string;
}

/** A pane at a position on the lattice. */
export interface Pane extends Placed {
  /** Renders to fit the cells it is given. */
  render(view: PaneView): ReactNode;
}

/**
 * Panes at positions.
 *
 * A pane occupies exactly one lattice cell. Adjacency is derived from position
 * rather than declared, so adding a pane wires its neighbours for free.
 *
 * The type parameter carries whatever the caller puts on the lattice. Everything
 * that only reads positions takes `Lattice<Placed>` and accepts any of them.
 */
export interface Lattice<P extends Placed = Pane> {
  panes: readonly P[];
}

export function lattice<P extends Placed>(panes: readonly P[]): Lattice<P> {
  if (panes.length === 0) throw new Error("a lattice needs at least one pane");
  const ids = new Set<string>();
  const taken = new Map<string, string>();
  for (const pane of panes) {
    if (ids.has(pane.id)) throw new Error(`duplicate pane id "${pane.id}"`);
    ids.add(pane.id);
    const place = pane.at.join(",");
    const holder = taken.get(place);
    if (holder) throw new Error(`panes "${holder}" and "${pane.id}" share position ${place}`);
    taken.set(place, pane.id);
  }
  // A copy, so the checks above hold for the life of the lattice.
  return { panes: [...panes] };
}

export function paneById<P extends Placed>(of: Lattice<P>, id: string): P | undefined {
  return of.panes.find((pane) => pane.id === id);
}

export function paneAt<P extends Placed>(of: Lattice<P>, at: Coord): P | undefined {
  return of.panes.find((pane) => same(pane.at, at));
}

/** The pane one step away, when something is there. */
export function neighbour<P extends Placed>(of: Lattice<P>, from: Placed, heading: Heading): P | undefined {
  return paneAt(of, step(from.at, heading));
}

/** The headings that lead somewhere, which is what a compass or a wall reads. */
export function exits(of: Lattice<Placed>, from: Placed): readonly Heading[] {
  return HEADINGS.filter((heading) => neighbour(of, from, heading) !== undefined);
}

/** The heading from one pane toward another, for a cue that points. */
export function towards(from: Placed, to: Placed): Heading | null {
  return bearing(from.at, to.at);
}

export function extent(of: Lattice<Placed>): Extent {
  return extentOf(of.panes.map((pane) => pane.at));
}

/** Lattice cells the whole lattice occupies, which sets how far a surface can widen. */
export function span(of: Lattice<Placed>): Cells {
  return spanOf(extent(of));
}

/** Panes grouped into their lattice rows, north first, each row west to east. */
export function rows<P extends Placed>(of: Lattice<P>): P[][] {
  const grouped = new Map<number, P[]>();
  for (const pane of of.panes) {
    const row = grouped.get(pane.at[1]) ?? [];
    row.push(pane);
    grouped.set(pane.at[1], row);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => [...row].sort((a, b) => a.at[0] - b.at[0]));
}
