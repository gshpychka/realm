# @pituitary/ember

Fire for terminal cells: a small simulation of burning air, drawn in block characters, sized to
whatever box it is given: a strip, a column, a tile, or a wide rectangle.

```sh
just ember tune       # one fire under several settings, side by side
just ember flames     # small flames beside large ones
just ember tiles      # or row1, row2, columns
```

## How it burns

A fuel bed beneath the bottom row heats the air above it. Each step the temperature is carried
along a velocity field and cools:

- the velocity is buoyant lift, stronger where the air is hotter, so hot air outruns cool air and
  draws up into tongues; turbulence as the curl of a drifting noise field, which swirls heat
  without piling it anywhere; and wind with a slow sway;
- each pixel looks back along the velocity to where its air came from, so any speed is stable;
- cooling follows two noise fields that rise with the flame, broad patches that part it into
  tongues and fine ones that fray their edges;
- sparks leave the bed, ride upward faster than the flame, and fade.

Heat maps to colour through a continuous gradient, from an ember barely lit against the
background to a near-white core, in gruvbox dark.

## Primitives

```tsx
import { Fire, FireColumn, FireRow, FireTile } from "@pituitary/ember";

<FireTile size="3x2" />                    // columns × rows: 2x2, 2x3, 3x2, 3x3
<FireRow rows={2} />                       // along the width of its parent
<FireColumn cols={1} />                    // down the height of its parent
<Fire mapping="quadrant" width={24} height={8} reach={1.2} sparks={4} />
```

## Hyperparameters

Every primitive takes these. Distances are in cells; defaults scale with the fire's size, so one
set of options suits a strip and a tile.

| option | default | |
| --- | --- | --- |
| `fuel` | `even` | heat along the bed: `even`, `arch`, `flame`, `cooling`, `twin`, `travelling()`, `litFuel()`, `banked()` |
| `intensity` | 1.05 | heat the fuel gives; 1 burns white at the core |
| `reach` | 1.05 | fraction of the height a fully fed flame climbs |
| `rise` | scales | upward speed of the hottest air, cells per step |
| `turbulence` | 0.8 | strength of the swirl; 0 climbs straight |
| `scale` | scales | size of the eddies; smaller splits the flame into more tongues |
| `patchiness` | 1 | how unevenly the air cools; higher leaves dark gaps between tongues |
| `spread` | 0.15 | how much heat bleeds to its neighbours |
| `point` | 0 | how much faster the margins cool, so the flame climbs to a point |
| `lean` · `sway` | 0 · 0.25 | steady wind · slow side-to-side sway, cells per step |
| `flicker` · `flickerRate` | 0.4 · 0.35 | depth and speed of the bed's flicker |
| `sparks` | 1.5 | sparks per step per 100 pixels of width, in fires tall enough to throw them |
| `seed` | 1 | the same seed burns the same way |
| `mapping` | `half` | how a cell spends its pixels, below |
| `colours` | `FLAME` | heat-to-colour stops, coolest first |
| `pace` · `still` | 70 ms · false | step interval · hold one warmed frame |

Resizing a `Fire` resamples its existing heat, keeping the flame continuous. Changing its seed or
mapping starts a fresh hearth; removing a tuning prop restores its default as the fire burns.

## Mappings

| mapping | pixels per cell | spent on |
| --- | --- | --- |
| `shade` | 1 × 1 | coverage, `░▒▓█` |
| `solid` | 1 × 1 | colour alone |
| `half` | 1 × 2 | two square pixels, each with its own colour |
| `sideways` | 2 × 1 | two pixels side by side |
| `quadrant` | 2 × 2 | four pixels clustered into two colours; the most flame-like at small sizes |
| `eighths` | 1 × 8 | height, measured up from the cell floor |
| `gauge` | 1 × 1 | amplitude, filled upward |
| `taper` | one per row | amplitude across the strip, filled from the left |

## Without React

`kindle`, `stoke`, and `warm` run the simulation, `reshape` carries a burning hearth onto a grid of
another size, `paint` maps a hearth to cells of `{ char, fg, bg }` heats, and `glow` and
`shader` map a heat to a colour, and `mix` blends two colours.

## An evening

A fire left burning for hours moves through phases. `evening` begins one from a table of phases,
each with how long it lasts (a range of seconds), the phases that may follow it and their weights,
and a `Temper`: the hearth's options and its step interval. `temperAt` reads how the fire burns
any number of seconds in: a new phase blends in over 15 s, its fuel changing halfway, and within a
phase the intensity wanders slowly. `blend` gives a temper part of the way between two. Every draw
comes from the `Random` the evening is given, so `seeded` burns the same evening each time.

`FIREPLACE` is a fireplace's evening for a fire one row tall: it catches, roars, burns steadily,
settles, sinks to embers, and catches again as a log goes on.

```ts
const night = evening(FIREPLACE, "steady", Math.random);
const { pace, options } = temperAt(night, seconds);
```

## Light

`lights` reads a hearth as one point of light per cell column, at the centre of the light it
radiates, which grows with the fourth power of heat. `irradiance` sums that light at any cell around the fire, falling to
half at `radius` cells and counting a row as `aspect` columns, and `shine` lights a `#rrggbb`
colour by it in linear light: `albedo` sets how much of its own colour the surface reflects, and
`sheen` how much light it scatters whatever its colour. `linear` reads a `#rrggbb` colour as light.

## Remains

What a fire leaves once it has burned down. `bank` lays a bed of coals, one per cell, each of a
fixed height; `smoulder` gives a coal's glyph and heat at a moment, breathing, and going out by
its `cooling` time, and `coalColour` fades it toward `ASH` or any colour it ends in. `plume` is
smoke, a hearth of haze whose fuel dies away: `billow` steps it, `puffs` reads it in the rows
above its base, and `smokeRamp` greys it over the fill beneath. `cinders` throws sparks that rise
and fade, and `flight` says where one is. `coalLights` and `cinderLights` give their light as
`lights` gives a fire's, and `lights` takes a ramp of its own for a flame of another colour.
