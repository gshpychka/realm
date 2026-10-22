import { describe, expect, test } from "bun:test";
import type { Coord } from "./coord.ts";
import { type Lattice, lattice, type Placed } from "./lattice.ts";
import { arrived, position } from "./passage.ts";
import { pace, reach, type Standing, stand, walk } from "./standing.ts";

function placed(id: string, at: Coord): Placed {
  return { id, at };
}

/**
 *        past
 *   talk code diff
 *        ask
 *
 * `off` stands away from all of it, with nothing adjoining it.
 */
const plan: Lattice<Placed> = lattice([
  placed("talk", [0, 0]),
  placed("code", [1, 0]),
  placed("diff", [2, 0]),
  placed("past", [1, -1]),
  placed("ask", [1, 1]),
  placed("off", [-3, 2]),
]);

const here = (of: Lattice<Placed>, id: string) => stand(paneOrThrow(of, id));

function paneOrThrow(of: Lattice<Placed>, id: string): Placed {
  const found = of.panes.find((pane) => pane.id === id);
  if (!found) throw new Error(`no pane "${id}"`);
  return found;
}

/** Paces until the movement settles, and says how many it took. */
function settle(from: Standing): { standing: Standing; steps: number } {
  let standing = from;
  let steps = 0;
  while (!arrived(standing.passage) && steps < 200) {
    standing = pace(standing);
    steps++;
  }
  return { standing, steps };
}

describe("standing somewhere", () => {
  test("a new standing is at rest on its pane", () => {
    const standing = here(plan, "code");
    expect(standing.here).toBe("code");
    expect(position(standing.passage)).toEqual([1, 0]);
    expect(arrived(standing.passage)).toBe(true);
    expect(standing.heading).toBe(null);
    expect(standing.back).toBe(null);
  });
});

describe("walking", () => {
  test("a step enters the neighbour that way at once", () => {
    const standing = walk(plan, here(plan, "talk"), "east");
    expect(standing.here).toBe("code");
    expect(standing.heading).toBe("east");
  });

  test("the surface is still behind while the pane is already entered", () => {
    const standing = walk(plan, here(plan, "talk"), "east");
    expect(position(standing.passage)).toEqual([0, 0]);
    expect(arrived(standing.passage)).toBe(false);
  });

  test("the way back is the heading reversed, and outlives the passage", () => {
    const { standing } = settle(walk(plan, here(plan, "talk"), "east"));
    expect(standing.back).toBe("west");
    expect(standing.heading).toBe(null);
  });

  test("a step with nothing that way changes nothing at all", () => {
    const standing = here(plan, "talk");
    expect(walk(plan, standing, "north")).toBe(standing);
    expect(walk(plan, standing, "south")).toBe(standing);
    expect(walk(plan, standing, "west")).toBe(standing);
  });

  test("every heading walks", () => {
    const from = here(plan, "code");
    expect(walk(plan, from, "north").here).toBe("past");
    expect(walk(plan, from, "east").here).toBe("diff");
    expect(walk(plan, from, "south").here).toBe("ask");
    expect(walk(plan, from, "west").here).toBe("talk");
  });

  test("a walk lands exactly on the pane it entered", () => {
    const { standing } = settle(walk(plan, here(plan, "talk"), "east"));
    expect(position(standing.passage)).toEqual([1, 0]);
  });

  test("the heading clears in the step that lands, never a step later", () => {
    let standing = walk(plan, here(plan, "talk"), "east");
    while (!arrived(standing.passage)) {
      const next = pace(standing);
      // Under way carries a heading; the moment it lands, the heading is gone.
      expect(next.heading === null).toBe(arrived(next.passage));
      standing = next;
    }
  });

  test("a walk begun mid-passage starts from wherever the surface has got to", () => {
    const under = pace(pace(walk(plan, here(plan, "talk"), "east")));
    const turned = walk(plan, under, "north");
    expect(turned.here).toBe("past");
    expect(turned.passage.from).toEqual(position(under.passage));
    expect(turned.passage.from[0]).toBeGreaterThan(0);
  });

  test("pacing a settled standing returns it unchanged", () => {
    const standing = here(plan, "code");
    expect(pace(standing)).toBe(standing);
  });

  test("a walk from a pane the lattice no longer holds changes nothing", () => {
    const orphan: Standing = { ...here(plan, "code"), here: "gone" };
    expect(walk(plan, orphan, "east")).toBe(orphan);
  });
});

describe("reaching", () => {
  test("a reach enters the pane named, with no heading", () => {
    const standing = reach(plan, here(plan, "talk"), "off");
    expect(standing.here).toBe("off");
    expect(standing.heading).toBe(null);
    expect(standing.back).toBe(null);
  });

  test("a reach is the only way into a pane nothing adjoins", () => {
    const island = paneOrThrow(plan, "off");
    for (const heading of ["north", "east", "south", "west"] as const) {
      expect(walk(plan, here(plan, "off"), heading).here).toBe("off");
    }
    expect(reach(plan, here(plan, "talk"), island.id).here).toBe("off");
  });

  test("a reach for the pane already stood in changes nothing", () => {
    const standing = here(plan, "code");
    expect(reach(plan, standing, "code")).toBe(standing);
  });

  test("a reach for a pane the lattice does not hold changes nothing", () => {
    const standing = here(plan, "code");
    expect(reach(plan, standing, "nowhere")).toBe(standing);
  });

  test("a reach clears the way back, which no longer leads anywhere", () => {
    const { standing } = settle(walk(plan, here(plan, "talk"), "east"));
    expect(standing.back).toBe("west");
    expect(reach(plan, standing, "off").back).toBe(null);
  });

  test("a reach across the lattice lands exactly, however far", () => {
    const { standing, steps } = settle(reach(plan, here(plan, "diff"), "off"));
    expect(position(standing.passage)).toEqual([-3, 2]);
    expect(steps).toBeLessThan(30);
  });
});
