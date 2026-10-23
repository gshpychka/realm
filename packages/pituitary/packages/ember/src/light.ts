import { type Mapping, pixels } from "./cells.ts";
import { type Hearth, heatAt } from "./hearth.ts";
import { FLAME, glow, lit, type Stop } from "./ramp.ts";

/** A colour as linear-light red, green, blue, each 0..1 (or above 1 for light that sums past white). */
export type Rgb = readonly [number, number, number];

/** A point of light, in cells: `x` columns across and `y` rows down from the top-left cell of the fire's box. */
export interface Light {
  x: number;
  y: number;
  colour: Rgb;
  power: number;
}

/** A hot body radiates with the fourth power of its temperature (Stefan–Boltzmann). */
const RADIANCE = 4;

/**
 * The fire drawn `cols` × `rows` cells as lights: one per cell column, placed at the centre of the light that
 * column radiates, with power the light its heat radiates, growing with the fourth power of heat (a column lit at
 * heat 1 over one full cell height gives power 1), and the colour it glows through `colours`.
 * Columns with nothing lit give no light.
 */
export function lights(
  hearth: Hearth,
  mapping: Mapping,
  cols: number,
  rows: number,
  colours: readonly Stop[] = FLAME,
): Light[] {
  const [width, height] = pixels(mapping, cols, rows);
  const down = height / Math.max(1, rows);
  const out: Light[] = [];
  for (let col = 0; col < cols; col++) {
    // A mapping narrower than its cells, such as `taper`, spreads one pixel column over several cells.
    const first = Math.floor((col * width) / cols);
    const last = Math.max(first + 1, Math.floor(((col + 1) * width) / cols));
    let radiated = 0;
    let rowSum = 0;
    let heatSum = 0;
    for (let x = first; x < last; x++) {
      for (let y = 0; y < height; y++) {
        const heat = heatAt(hearth, x, y);
        if (!lit(heat)) continue;
        const radiance = heat ** RADIANCE;
        radiated += radiance;
        rowSum += radiance * (y + 0.5);
        heatSum += radiance * heat;
      }
    }
    if (radiated === 0) continue;
    out.push({
      x: col + 0.5,
      y: rowSum / radiated / down,
      colour: linear(glow(heatSum / radiated, colours)),
      power: radiated / ((last - first) * down),
    });
  }
  return out;
}

/** How light spreads from a source. */
export interface Falloff {
  /** Cells from a source at which its light has fallen to half. Default 3. */
  radius?: number;
  /** How many times taller a cell is than wide, so distance counts the same both ways. Default 2. */
  aspect?: number;
  /** Cells beyond which light counts as none. Default radius × 6. */
  reach?: number;
}

/** Light arriving at the centre of cell (`x`, `y`), in the lights' own coordinates. */
export function irradiance(lights: readonly Light[], x: number, y: number, falloff: Falloff = {}): Rgb {
  const radius = falloff.radius ?? 3;
  const aspect = falloff.aspect ?? 2;
  const reach = falloff.reach ?? radius * 6;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const light of lights) {
    const dx = x + 0.5 - light.x;
    const dy = (y + 0.5 - light.y) * aspect;
    const distance = dx * dx + dy * dy;
    if (distance > reach * reach) continue;
    const share = light.power / (1 + distance / (radius * radius));
    red += light.colour[0] * share;
    green += light.colour[1] * share;
    blue += light.colour[2] * share;
  }
  return [red, green, blue];
}

/** How a surface answers light. */
export interface Surface {
  /** How much of its own colour a surface reflects, 0..1. Default 1. */
  albedo?: number;
  /** Light a surface scatters whatever its own colour, as haze or gloss does. Default 0. */
  sheen?: number;
}

/** `colour` (`#rrggbb`) as it looks under `light`, as `#rrggbb`. No light leaves it unchanged. */
export function shine(colour: string, light: Rgb, surface: Surface = {}): string {
  if (light.every((channel) => channel <= 0)) return colour;
  const albedo = surface.albedo ?? 1;
  const sheen = surface.sheen ?? 0;
  const base = linear(colour);
  return hex(
    [0, 1, 2].map((index) => {
      const own = base[index] ?? 0;
      const arriving = Math.max(0, light[index] ?? 0);
      return own + own * arriving * albedo + arriving * sheen;
    }),
  );
}

/** `#rrggbb` in linear light, through the sRGB transfer function. */
export function linear(colour: string): Rgb {
  const value = Number.parseInt(colour.slice(1), 16);
  const decode = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [decode((value >> 16) & 0xff), decode((value >> 8) & 0xff), decode(value & 0xff)];
}

/** Linear light as `#rrggbb`, each channel clamped to 0..1. */
function hex(channels: readonly number[]): string {
  const encode = (channel: number) => {
    const c = Math.min(1, Math.max(0, channel));
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(s * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channels.map(encode).join("")}`;
}
