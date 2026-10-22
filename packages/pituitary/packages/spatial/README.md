# @pituitary/spatial

A spatial surface for terminal panes. Panes sit at positions on a lattice, one pane to a cell,
and adjacency follows from position, so a pane's ways out are whatever the lattice puts beside it.
The operator walks from pane to pane and the surface eases after them; the same surface widens out
until every pane is on screen at once and closes back in on one, along a single scale. A pane
renders to fit the cells it is handed, and position stays with the lattice.

```
                      history              y = -1
                         │
  settings ─── talk ─── code ─── changes    y =  0
                         │
                     questions              y =  1
```

Six panes across four columns and three rows: `talk` at `[0, 0]`, `code` at `[1, 0]`, `settings`
at `[-1, 0]`, `history` at `[1, -1]`. North decreases y, so walking north from `code` enters
`history`; walking north from `talk` stays put, because nothing sits there.

## A lattice you can walk

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot, useTerminalDimensions } from "@opentui/react";
import { lattice, type Pane, Surface, useNavigation } from "@pituitary/spatial";

const PANES: readonly Pane[] = [
  { id: "talk", at: [0, 0], name: "talk", render: () => <text>conversation</text> },
  {
    id: "code",
    at: [1, 0],
    name: "code",
    render: ({ detailed }) => <text>{detailed ? "src/payouts/limits.ts" : "1 file"}</text>,
  },
  { id: "history", at: [1, -1], name: "history", render: () => <text>12 turns</text> },
];

const plan = lattice(PANES);

function App() {
  const { width, height } = useTerminalDimensions();
  const nav = useNavigation(plan, { start: "talk", peek: [6, 0] });

  return <Surface nav={nav} size={[width, height]} />;
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
```

Arrows and `hjkl` walk, `-` widens out, `+` closes in. Ctrl and Alt chords remain available to
the pane. `lattice()` requires nonempty ids and safe integer coordinates, and rejects a duplicate
id, two panes on one position, or an empty set. Pane objects retain their identity and rendering
behavior; the lattice owns a copy of their collection.

## useNavigation

```ts
useNavigation(of: Lattice, options?: NavigationOptions): Navigation
```

Where the operator is and how close the surface is held. `focus` is the pane they are in and moves
the instant they set off; `at` is the surface's lattice position, fractional through the passage
that catches up. `zoom` carries the held scale, `busy` is true while the passage or the scale is
moving, and `back` is the heading that returns to the previous pane.

| Option | |
| --- | --- |
| `start` | Pane id to begin in. The first pane in the lattice answers an absent or unknown id. |
| `peek` | Cells the focused pane gives up per axis. `[0, 0]` by default. |
| `scale` | Scale to begin at. `NEAR` by default. |
| `keys` | Bindings merged over `DEFAULT_KEYS` per action, or `false` to bind none. |
| `jumps` | Keys that go straight to a pane, by pane id. Independent of `keys`. |

`go(heading)` walks one step where the lattice allows it, `jump(id)` travels straight to a pane,
and `widen`, `close`, `toggleZoom` move the scale.

A walk reaches only panes the lattice puts side by side, so a pane with no neighbour in any
direction is reachable by `jump` alone. `jumps` binds that to a key:

```ts
useNavigation(plan, { jumps: { "1": "talk", "2": "code", "3": "history" } });
```

## Surface

```tsx
<Surface nav={nav} size={[cols, rows]} frame={frame} />
```

The opening onto the lattice. `size` is the cells the surface may draw into, which is the terminal
less whatever chrome the caller keeps for itself. Panes hold their positions at every scale and the
surface moves and resizes around them; a pane outside the frame is skipped, so its `render` runs
only while it contributes something.

`frame` wraps each drawn pane in the shell the design gives its panes, receiving a `FrameView`:
`{ pane, size, focused, exits, children }`. `exits` is that pane's headings that lead somewhere,
so a wall can take its weight from adjacency without the frame holding the lattice:

```tsx
frame={({ pane, size, focused, exits, children }) => (
  <box
    width={size[0]}
    height={size[1]}
    border
    title={pane.name}
    borderColor={focused ? "#e8c07d" : "#4a4a4a"}
    borderStyle={exits.length === 0 ? "heavy" : "single"}
  >
    {children}
  </box>
)}
```

## Minimap

```tsx
<Minimap lattice={nav.lattice} focus={nav.focus.id} mark={mark} />
```

The lattice drawn as a lattice: one cell per position, `gap` (a space by default) where no pane
sits. The blanks carry the shape, so a pane off the main row reads as above or below the pane it
adjoins.

`mark(pane, { focused })` returns a `{ glyph, colour? }` per pane, reading whatever state the
caller tracks. `minimapSize(lattice)` is the cells it occupies, for a caller sizing a permanent
strip. It takes a lattice and a focused id rather than a `Navigation`, so a lattice nobody is
walking can still be drawn.

```tsx
mark={(pane, { focused }) => ({
  glyph: focused ? "●" : unseen.includes(pane.id) ? "▪" : "·",
  colour: focused ? "#e8c07d" : undefined,
})}
```

## peek

`peek` is the adjacency cue: cells per axis the focused pane gives up, leaving its neighbour
showing at the edge. The whole cue is that visible sliver, so what lies each way is legible
without a map.

With a 100 × 27 viewport and `peek: [6, 0]`, the focused pane is 94 × 27. Centred, the six columns
split across both edges:

```
├────────┬───────────────────────────────────────────────┬────────┤
│settings│                talk · 94 × 27                 │  code  │
└────────┴───────────────────────────────────────────────┴────────┘
  3 cols                                                   3 cols
```

The surface holds inside the lattice, so against an edge the whole six falls on the inward side:

```
├────────────────────────────────────────────────────────┬────────┤
│                   settings · 94 × 27                   │  talk  │
└────────────────────────────────────────────────────────┴────────┘
                                                           6 cols
```

The y component peeks the same way over rows, and an axis the lattice does not extend along keeps
its whole viewport: a single row of panes has nothing above or below to reveal, so its y peek costs
it nothing however wide it is asked for. `[0, 0]` (`NO_PEEK`) gives the focused pane the whole
viewport on both axes. Peek scales with how close the surface is held, so widening out brings the
neighbours into view whole.

## Zoom

One eased scale from `NEAR` (1, a single pane filling the viewport) to `FAR` (0, every pane at
once). `nav.widen()` targets `FAR`, `nav.close()` targets `NEAR`, `nav.toggleZoom()` swaps, and
`zoom.scale` eases toward `zoom.target` a fraction of the remaining distance every 24 ms, landing
exactly on it. `DEFAULT_KEYS` covers walking, widening out, and closing in; `toggleZoom` is there
for a caller who binds one key to both.

| Keys | |
| --- | --- |
| `←` `→` `↑` `↓`, `h` `l` `k` `j` | walk west, east, north, south |
| `-`, `z` | widen out |
| `+`, `=`, `return` | close in |

A pane's cells come from the scale, and `detailed` is true while the surface is close enough for
detail to be worth drawing (`scale > DETAIL`, 0.72). Both arrive in `PaneView`, and a pane reads
them to choose how much to draw:

```tsx
export function Changes({ size: [width], detailed }: PaneView) {
  if (!detailed || width < TILE) return <Digest>3 files +96 -8</Digest>;
  return <FileList />;
}
```

For the plan above in a 100 × 27 viewport, with `peek: [6, 0]`:

| scale | pane cells | `detailed` |
| --- | --- | --- |
| 1 (`NEAR`) | 94 × 27 | yes |
| 0.75 | 77 × 23 | yes |
| 0.45 | 56 × 17 | no |
| 0.20 | 39 × 13 | no |
| 0 (`FAR`) | 25 × 9 | no |

A pane holds a `FLOOR` of 8 × 3 cells. `FAR` seats the whole plan while the viewport affords that
much per lattice cell, and as much of the plan as fits past that.

## Geometry without React

The React pieces sit on pure modules a caller can use on their own.

| Module | |
| --- | --- |
| `coord` | `Coord` is `readonly [x, y]` in lattice cells and `Cells` is `readonly [columns, rows]` in terminal cells. `Extent` is a region, from `extentOf`, measured by `spanOf`. `step`, `same`, `bearing`, `OPPOSITE`, `HEADINGS`. North decreases y. |
| `lattice` | Construction and validation, plus `paneAt`, `paneById`, `neighbour`, `exits`, `towards`, `extent`, `span`, `rows`. A `Placed` is an id at a position; a `Pane` is a `Placed` that renders. |
| `viewport` | `strideAt(extent, viewport, scale, peek?)`, `originFor`, `offsetOf`, `onScreen`, `FLOOR`: where a pane lands on screen at a given scale. Takes a region rather than a lattice, so it holds no opinion about what occupies one. A scale outside 0..1 is held at the end it passed. |
| `passage` | `resting`, `depart`, `position`, `advance`, `arrived`: the eased walk between two positions. |
| `standing` | `stand`, `walk`, `reach`, `pace`: where the operator is on a lattice, as a value. This is what `useNavigation` holds. |
| `zoom` | `zoom`, `to`, `toggle`, `ease`, `steady`, `detailed`, and the `NEAR`, `FAR`, `DETAIL` constants. |
| `ease` | `approach` and `settled`: a fraction of the remaining distance per step, landing exactly on the target. |

```ts
const held = zoom(0.5);
const within = extent(plan);
const stride = strideAt(within, [100, 27], held.scale, [6, 0]);
const origin = originFor(within, stride, [0, 0], [100, 27]);
const where = offsetOf([1, 0], stride, origin);
const visible = onScreen(where, stride, [100, 27]);
```

`Passage` and `Zoom` are plain values with a step function, so a caller driving their own clock
folds `advance` and `ease` on whatever tick they already have.

## What the caller owns

- The shell around a pane. `frame` receives the pane, its cells, its focus, and its ways out, and
  draws whatever the design says: walls, titles, padding, colour.
- What a mark means. `mark` returns a glyph and colour per pane, so attention, agent position, and
  unread state stay the caller's vocabulary.
- Key bindings. `keys` takes the actions a caller wants to rebind, merged over the defaults;
  `keys: false` binds none, for a pane that owns the keyboard. `jumps` binds a key to a pane.
- What a pane contains. A pane reads its cells and `detailed`, and decides what reading fits.
