import { type Falloff, irradiance, type Light, type Rgb, shine } from "@pituitary/ember";

/**
 * The screen's cells as the renderer holds them: a char per cell, and r, g, b, a per cell for fg and bg,
 * each u16 an 8-bit channel in its low byte under a byte of the colour's metadata.
 */
export interface Cells {
  char: Uint32Array;
  fg: Uint16Array;
  bg: Uint16Array;
}

/** What answers the fire's light: text and fill, fill, text, or `light`, which shows the light alone. */
export type Lit = "everything" | "fills" | "text" | "light";

/** How the fire lights the screen around it. */
export interface Firelight {
  /** Cells from a light at which it has fallen to half; `null` lights nothing. */
  radius: number | null;
  /** How many times the arriving light a cell shows. */
  exposure: number;
  lit: Lit;
  /** Light a cell scatters whatever its colour. */
  sheen: number;
}

const RADIUS = { off: null, close: 1.5, room: 3, wide: 6 };
// The burning corner fire lights the cell left of it, at radius 3, with a mean red of 0.5, 1.2, and 2.6.
const EXPOSURE = { faint: 12, warm: 28, bright: 62 };
const LIT = { everything: "everything", fills: "fills", text: "text", light: "light" } as const;
const SHEEN = { none: 0, soft: 0.05, smoky: 0.14 };

/** The firelight `env` asks for, each unknown or absent setting at its default. */
export function firelight(env: Record<string, string | undefined> = process.env): Firelight {
  return {
    radius: choose(RADIUS, env.PITUITARY_FIRELIGHT, "close"),
    exposure: choose(EXPOSURE, env.PITUITARY_FIRELIGHT_STRENGTH, "warm"),
    lit: choose(LIT, env.PITUITARY_FIRELIGHT_ON, "text"),
    sheen: choose(SHEEN, env.PITUITARY_FIRELIGHT_HAZE, "soft"),
  };
}

function choose<K extends string, T>(table: Record<K, T>, value: string | undefined, fallback: K): T {
  return value !== undefined && Object.hasOwn(table, value) ? table[value as K] : table[fallback];
}

/** A terminal cell is twice as tall as it is wide. */
const ASPECT = 2;
/** Radii past which light counts as none. */
const REACH = 6;
const SPACE = 0x20;
/** The renderer's intent for an rgb colour, which it keeps in the high byte of the green channel. */
const INTENT_RGB = 0;

const BYTE = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

/**
 * Lights `cells`, a `width` × `height` screen, by `lights` given in screen cells, in place.
 * Only cells the light reaches change, and of those only colours given as rgb and not fully transparent.
 */
export function relight(
  cells: Cells,
  width: number,
  height: number,
  lights: readonly Light[],
  setting: Firelight,
): void {
  if (setting.radius === null || lights.length === 0) return;
  const reach = setting.radius * REACH;
  const falloff: Falloff = { radius: setting.radius, aspect: ASPECT, reach };
  // Cell (x, y) is lit from its centre, (x + 0.5, y + 0.5).
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (const light of lights) {
    left = Math.min(left, Math.floor(light.x - 0.5 - reach));
    right = Math.max(right, Math.ceil(light.x - 0.5 + reach));
    top = Math.min(top, Math.floor(light.y - 0.5 - reach / ASPECT));
    bottom = Math.max(bottom, Math.ceil(light.y - 0.5 + reach / ASPECT));
  }
  left = Math.max(0, left);
  right = Math.min(width - 1, right);
  top = Math.max(0, top);
  bottom = Math.min(height - 1, bottom);
  const surface = { sheen: setting.sheen };
  const text = setting.lit === "everything" || setting.lit === "text";
  const fills = setting.lit === "everything" || setting.lit === "fills";
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const arriving = irradiance(lights, x, y, falloff);
      if (arriving[0] === 0 && arriving[1] === 0 && arriving[2] === 0) continue;
      const light: Rgb = [
        arriving[0] * setting.exposure,
        arriving[1] * setting.exposure,
        arriving[2] * setting.exposure,
      ];
      const cell = y * width + x;
      if (setting.lit === "light") {
        paint(cells.bg, cell, shine("#000000", light, { sheen: 1 }));
        continue;
      }
      if (text && cells.char[cell] !== SPACE) answer(cells.fg, cell, light, surface);
      if (fills) answer(cells.bg, cell, light, surface);
    }
  }
}

/** Lights the colour of `cell` in `colours`, keeping its metadata. */
function answer(colours: Uint16Array, cell: number, light: Rgb, surface: { sheen: number }): void {
  const at = cell * 4;
  const r = colours[at] ?? 0;
  const g = colours[at + 1] ?? 0;
  const b = colours[at + 2] ?? 0;
  const a = colours[at + 3] ?? 0;
  if (g >> 8 !== INTENT_RGB || (a & 0xff) === 0) return;
  const lit = shine(`#${BYTE[r & 0xff]}${BYTE[g & 0xff]}${BYTE[b & 0xff]}`, light, surface);
  const value = Number.parseInt(lit.slice(1), 16);
  colours[at] = (r & 0xff00) | ((value >> 16) & 0xff);
  colours[at + 1] = (g & 0xff00) | ((value >> 8) & 0xff);
  colours[at + 2] = (b & 0xff00) | (value & 0xff);
}

/** Sets the colour of `cell` in `colours` to `colour`, opaque rgb. */
function paint(colours: Uint16Array, cell: number, colour: string): void {
  const value = Number.parseInt(colour.slice(1), 16);
  colours.set([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 0xff], cell * 4);
}
