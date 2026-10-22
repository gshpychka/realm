/**
 * A spatial surface for terminal panes.
 *
 * Panes sit at positions on a lattice. The operator walks between them, the surface
 * follows, and the same surface widens out to show every pane at once and closes back
 * in — one eased scale, not an overview mode. Three pieces are worth knowing:
 *
 *   useNavigation  where the operator is, how close the surface is held, and the keys
 *   Surface        the opening onto the lattice, at whatever scale is current
 *   Minimap        the lattice drawn as a lattice, for an always-present cue
 *
 * `peek` is the adjacency cue: cells of the neighbouring pane left on screen.
 */

export {
  bearing,
  type Cells,
  type Coord,
  type Extent,
  extentOf,
  HEADINGS,
  type Heading,
  OPPOSITE,
  same,
  spanOf,
  step,
} from "./coord.ts";
export { approach, settled } from "./ease.ts";
export {
  type Bindings,
  DEFAULT_KEYS,
  type Jumps,
  type KeyMap,
  type Move,
  moveFor,
} from "./keys.ts";
export {
  exits,
  extent,
  type Lattice,
  lattice,
  neighbour,
  type Pane,
  type PaneView,
  type Placed,
  paneAt,
  paneById,
  rows,
  span,
  towards,
} from "./lattice.ts";
export { type Mark, Minimap, type MinimapProps, minimapSize } from "./minimap.tsx";
export { type Navigation, type NavigationOptions, useNavigation } from "./navigation.ts";
export { advance, arrived, depart, type Passage, position, resting } from "./passage.ts";
export { pace, reach, type Standing, stand, walk } from "./standing.ts";
export { type Frame, type FrameView, Surface, type SurfaceProps } from "./surface.tsx";
export { FLOOR, NO_PEEK, offsetOf, onScreen, originFor, type Peek, strideAt } from "./viewport.ts";
export { DETAIL, detailed, ease, FAR, NEAR, steady, to, toggle, type Zoom, zoom } from "./zoom.ts";
