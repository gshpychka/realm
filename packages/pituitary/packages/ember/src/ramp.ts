/** A colour a fire passes through, at a heat from 0 to 1. */
export interface Stop {
  at: number;
  colour: string;
}

/**
 * Heat to colour in gruvbox dark, from an ember barely lit against the background to
 * a core that burns near white. Heat below the first stop draws nothing.
 */
export const FLAME: readonly Stop[] = [
  { at: 0.06, colour: "#3c1410" },
  { at: 0.18, colour: "#7a0a05" },
  { at: 0.32, colour: "#b3200f" },
  { at: 0.48, colour: "#d65d0e" },
  { at: 0.64, colour: "#fe8019" },
  { at: 0.8, colour: "#fabd2f" },
  { at: 0.95, colour: "#fbf1c7" },
];

/** Heat below this is out. */
export const SPENT = FLAME[0]?.at ?? 0.06;

/** True when `heat` is hot enough to draw. */
export function lit(heat: number): boolean {
  return heat > SPENT;
}

/** The colour `heat` glows, blended between the two stops around it, as `#rrggbb`. */
export function glow(heat: number, stops: readonly Stop[] = FLAME): string {
  const first = stops[0];
  const last = stops.at(-1);
  if (!first || !last) return "#000000";
  if (heat <= first.at) return first.colour;
  if (heat >= last.at) return last.colour;
  for (let index = 1; index < stops.length; index++) {
    const high = stops[index];
    const low = stops[index - 1];
    if (!high || !low || heat > high.at) continue;
    const t = (heat - low.at) / (high.at - low.at);
    return mix(low.colour, high.colour, t);
  }
  return last.colour;
}

/** `a` blended toward `b` by `t`, 0..1, as `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const from = rgb(a);
  const to = rgb(b);
  return `#${from
    .map((channel, index) => Math.round(channel + ((to[index] ?? channel) - channel) * t))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgb(hex: string): number[] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
