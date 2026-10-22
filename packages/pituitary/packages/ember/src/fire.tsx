import { type BoxRenderable, type OptimizedBuffer, RGBA } from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { grain, type Mapping, paint, pixels } from "./cells.ts";
import type { Fuel } from "./fuel.ts";
import { type Hearth, type HearthOptions, kindle, stoke, warm } from "./hearth.ts";
import { FLAME, glow, type Stop } from "./ramp.ts";

/** Milliseconds per step, the pace flames flicker at without strobing. */
export const PACE_MS = 70;

type Dimension = number | "auto" | `${number}%`;

/**
 * How a fire burns and how it is drawn. Distances are in terminal cells and are carried
 * over to the mapping's pixels, so a setting reads the same under every mapping.
 */
export interface FireProps {
  /** How each cell spends its pixels. `half` by default. */
  mapping?: Mapping;
  fuel?: Fuel;
  /** Heat the fuel gives, where 1 burns white at the core. */
  intensity?: number;
  /** Fraction of the height a fully fed flame climbs before it cools out. */
  reach?: number;
  /** Upward speed of the hottest air, in cells per step. Scales with the height when absent. */
  rise?: number;
  /** Strength of the swirling flow, 0 for a flame that climbs straight. */
  turbulence?: number;
  /** Size of the eddies, in cells. Scales with the fire when absent. */
  scale?: number;
  /** How much heat bleeds to its neighbours each step, 0..1. */
  spread?: number;
  /** How unevenly the air cools, 0 for evenly: higher parts the flame into tongues with dark gaps between. */
  patchiness?: number;
  /** Steady wind, in cells per step; negative blows left. */
  lean?: number;
  /** How far the flame sways from side to side, in cells per step. */
  sway?: number;
  /** How much faster the margins cool than the centre, so the flame climbs to a point. */
  point?: number;
  /** How deep the bed's heat dips as it flickers, 0..1. */
  flicker?: number;
  /** How fast the bed flickers. */
  flickerRate?: number;
  /** Sparks thrown per step for every 100 pixels of width. */
  sparks?: number;
  seed?: number;
  /** Milliseconds per step. */
  pace?: number;
  /** Holds the fire on one warmed frame, for captures and reduced motion. */
  still?: boolean;
  /** Heat to colour, coolest stop first. */
  colours?: readonly Stop[];
  width?: Dimension;
  height?: Dimension;
  flexGrow?: number;
  flexShrink?: number;
}

/** Colours precomputed along the heat range, so drawing a cell is a lookup. */
const SHADES = 128;

/** Heat to colour through `colours`, as a lookup; a background of no heat is transparent. */
export function shader(colours: readonly Stop[] = FLAME): (heat: number, background?: boolean) => RGBA {
  const shades = Array.from({ length: SHADES + 1 }, (_, index) =>
    RGBA.fromHex(glow(index / SHADES, colours)),
  );
  const clear = RGBA.fromInts(0, 0, 0, 0);
  return (heat, background = false) =>
    background && heat === 0
      ? clear
      : (shades[Math.max(0, Math.min(SHADES, Math.round(heat * SHADES)))] ?? clear);
}

/**
 * A fire filling the box layout gives it.
 *
 * The hearth is sized to the box's cells under the mapping, and kindled afresh when
 * either changes, so a fire can stretch along a row or down a column with its parent.
 */
export function Fire({
  mapping = "half",
  pace = PACE_MS,
  still = false,
  colours = FLAME,
  width,
  height,
  flexGrow,
  flexShrink = 0,
  seed = 1,
  ...tuning
}: FireProps) {
  const box = useRef<BoxRenderable | null>(null);
  const hearth = useRef<{ fire: Hearth; key: string } | null>(null);
  const shade = useMemo(() => shader(colours), [colours]);

  const [across, down] = grain(mapping);
  const options: HearthOptions = { seed };
  for (const [name, value] of Object.entries(tuning) as [keyof typeof tuning, unknown][]) {
    if (value === undefined) continue;
    // Horizontal distances scale by the pixels across a cell, vertical ones by the pixels down.
    if (name === "rise") options.rise = (value as number) * down;
    else if (name === "lean" || name === "sway") options[name] = (value as number) * across;
    else if (name === "scale") options.scale = (value as number) * Math.max(across, down);
    else (options as Record<string, unknown>)[name] = value;
  }
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => {
      const held = hearth.current;
      if (!held) return;
      held.fire.options = { ...held.fire.options, ...latest.current };
      stoke(held.fire);
      box.current?.requestRender();
    }, pace);
    return () => clearInterval(timer);
  }, [pace, still]);

  function draw(this: BoxRenderable, buffer: OptimizedBuffer) {
    const cols = this.width;
    const rows = this.height;
    if (cols <= 0 || rows <= 0) return;
    const key = `${mapping}:${cols}x${rows}:${seed}`;
    if (hearth.current?.key !== key) {
      const [w, h] = pixels(mapping, cols, rows);
      hearth.current = { fire: warm(kindle(w, h, latest.current)), key };
    }
    const cells = paint(hearth.current.fire, mapping, cols, rows);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = cells[row * cols + col];
        if (!cell) continue;
        buffer.setCellWithAlphaBlending(
          this.x + col,
          this.y + row,
          cell.char,
          shade(cell.fg),
          shade(cell.bg, true),
        );
      }
    }
  }

  return (
    <box
      ref={box}
      width={width}
      height={height}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      renderAfter={draw}
    />
  );
}
