import type { ReactNode } from "react";
import type { Cells, Heading } from "./coord.ts";
import { exits, extent, type Pane } from "./lattice.ts";
import type { Navigation } from "./navigation.ts";
import { offsetOf, onScreen, originFor, strideAt } from "./viewport.ts";

/** Wraps a pane in whatever shell the design gives its panes. */
export type Frame = (props: FrameView) => ReactNode;

/** What a frame is told about the pane it wraps. */
export interface FrameView {
  pane: Pane;
  /** Cells the frame may draw into. */
  size: Cells;
  focused: boolean;
  /** Headings that lead somewhere, which is what a wall or a compass reads. */
  exits: readonly Heading[];
  children: ReactNode;
}

export interface SurfaceProps {
  nav: Navigation;
  /** Cells the surface may draw into. */
  size: Cells;
  frame?: Frame;
}

/**
 * The opening onto the lattice.
 *
 * Panes keep their positions at every scale; the surface moves and resizes around
 * them. That is what makes walking and widening out one movement rather than two
 * views, and it is why a pane never needs to know where it sits.
 */
export function Surface({ nav, size, frame }: SurfaceProps) {
  const within = extent(nav.lattice);
  const stride = strideAt(within, size, nav.zoom.scale, nav.peek);
  const origin = originFor(within, stride, nav.at, size);

  return (
    <box flexGrow={1} overflow="hidden" position="relative">
      {nav.lattice.panes.map((pane) => {
        const offset = offsetOf(pane.at, stride, origin);
        if (!onScreen(offset, stride, size)) return null;
        const focused = pane.id === nav.focus.id;
        const drawn = pane.render({ size: stride, focused, detailed: nav.detailed });
        return (
          <box
            key={pane.id}
            position="absolute"
            left={offset[0]}
            top={offset[1]}
            width={stride[0]}
            height={stride[1]}
            flexDirection="column"
          >
            {frame
              ? frame({ pane, size: stride, focused, exits: exits(nav.lattice, pane), children: drawn })
              : drawn}
          </box>
        );
      })}
    </box>
  );
}
