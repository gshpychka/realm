import type { Cells } from "./coord.ts";
import { extent, type Lattice, type Placed, paneAt } from "./lattice.ts";

/** How a pane appears on the minimap. */
export interface Mark {
  glyph: string;
  colour?: string;
}

export interface MinimapProps {
  lattice: Lattice<Placed>;
  /** Id of the pane to draw as focused. */
  focus: string;
  /** How to draw each pane. One cell per pane. */
  mark(pane: Placed, state: { focused: boolean }): Mark;
  /** Drawn where the lattice has no pane. A space keeps the lattice's shape legible. */
  gap?: string;
}

/**
 * The lattice, drawn as a lattice.
 *
 * One cell per position, blank where no pane sits. The blanks are what carry the
 * shape: the marks outline the lattice rather than listing it, so a pane off the
 * main row reads as above or below the pane it adjoins. A single row of marks cannot
 * do this however it is punctuated, which is why this takes the rows it needs.
 */
export function Minimap({ lattice, focus, mark, gap = " " }: MinimapProps) {
  const { min, max } = extent(lattice);

  return (
    <box flexDirection="column" flexShrink={0}>
      {range(min[1], max[1]).map((y) => (
        <box key={y} flexDirection="row">
          {range(min[0], max[0]).map((x) => {
            const pane = paneAt(lattice, [x, y]);
            if (!pane) return <text key={x}>{gap}</text>;
            const drawn = mark(pane, { focused: pane.id === focus });
            return (
              <text key={x} fg={drawn.colour}>
                {drawn.glyph}
              </text>
            );
          })}
        </box>
      ))}
    </box>
  );
}

/** Cells the minimap occupies, for a caller laying out a permanent surface. */
export function minimapSize(of: Lattice<Placed>): Cells {
  const { min, max } = extent(of);
  return [max[0] - min[0] + 1, max[1] - min[1] + 1];
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value++) out.push(value);
  return out;
}
