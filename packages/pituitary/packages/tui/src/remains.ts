import { type OptimizedBuffer, RGBA } from "@opentui/core";
import {
  ASH,
  bank,
  billow,
  type Cinder,
  type Coal,
  cinderLights,
  cinders,
  coalColour,
  coalLights,
  flame,
  flight,
  glow,
  type Hearth,
  kindle,
  type Light,
  lights,
  linear,
  mix,
  type Plume,
  paint,
  plume,
  puffs,
  type Stop,
  seeded,
  smokeRamp,
  smoulder,
  stoke,
  warm,
} from "@pituitary/ember";

/** What a fire leaves in its place while it is away. */
export interface Remains {
  /** Coals that keep glowing, cool to grey ash, or go dark one by one. */
  coals: "none" | "glowing" | "ash" | "wink";
  /** Milliseconds by which coals cooling to ash or winking out are out. */
  cooling: number;
  /** How much smoke rises, 0..1. */
  smoke: number;
  /** Sparks thrown per cell of the place's width, 0..2. */
  sparks: number;
  /** A fill that stays warm, dimming over a few seconds, or keeps a faint warmth. */
  warmth: "none" | "fading" | "lasting";
  /** A small blue pilot flame in the middle of the place. */
  pilot: boolean;
  /** A bed of grey ash wherever no coal lies. */
  ash: boolean;
}

const COALS = { none: "none", glowing: "glowing", ash: "ash", wink: "wink" } as const;
const WARMTH = { none: "none", fading: "fading", lasting: "lasting" } as const;
const SWITCH = { on: true, off: false };

/** The remains `env` asks for, each unknown or absent setting at its default. */
export function remains(env: Record<string, string | undefined> = process.env): Remains {
  return {
    coals: choose(COALS, env.PITUITARY_FIRE_COALS, "ash"),
    cooling: amount(env.PITUITARY_FIRE_COOLING, 60, 0.001, Infinity) * 1000,
    smoke: amount(env.PITUITARY_FIRE_SMOKE, 0.4, 0, 1),
    sparks: amount(env.PITUITARY_FIRE_SPARKS, 0.6, 0, 2),
    warmth: choose(WARMTH, env.PITUITARY_FIRE_WARMTH, "fading"),
    pilot: choose(SWITCH, env.PITUITARY_FIRE_PILOT, "off"),
    ash: choose(SWITCH, env.PITUITARY_FIRE_ASH, "off"),
  };
}

function choose<K extends string, T>(table: Record<K, T>, value: string | undefined, fallback: K): T {
  return value !== undefined && Object.hasOwn(table, value) ? table[value as K] : table[fallback];
}

/** `value` as a number held to `low`..`high`, or `fallback` when it is not one. */
function amount(value: string | undefined, fallback: number, low: number, high: number): number {
  const parsed = value === undefined || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? Math.min(high, Math.max(low, parsed)) : fallback;
}

/** A place's width in cells and where it lies on the screen. */
export interface Place {
  x: number;
  y: number;
  width: number;
}

/** Remains left in a place at `start`, in milliseconds on the clock the caller draws them by. */
export interface Remnant {
  settings: Remains;
  start: number;
  /** When the smoke and the pilot next step. */
  next: number;
  /** The moment every draw shows, for a screen held still; `null` follows the clock. */
  held: number | null;
  coals: Coal[];
  /** Eighths of ash in each cell, for a bed of ash. */
  bed: number[];
  smoke: Plume | null;
  thrown: Cinder[];
  pilot: Hearth | null;
}

/** Milliseconds between steps of the smoke and the pilot. */
const STEP_MS = 140;
/** The moment after leaving that a screen held still shows: sparks in flight, smoke risen. */
const HELD_MS = 1200;
/** Smoke rises through the two rows above its place. */
const SMOKE_ROWS = 2;
/** Milliseconds over which a fading warmth falls to about 5%. */
const FADING_MS = 5000;
/** The warmth a lasting fill keeps, 0..1. */
const LASTING = 0.35;
/** The deep red a warm fill blends toward. */
const EMBER = "#7a0a05";
/** The pilot light's colours, gruvbox dark's blues from the dark into near white. */
const PILOT: readonly Stop[] = [
  { at: 0.06, colour: "#3c3836" },
  { at: 0.3, colour: "#458588" },
  { at: 0.65, colour: "#83a598" },
  { at: 0.95, colour: "#fbf1c7" },
];
const PILOT_COLUMNS = 2;
const ASH_RISE = ["▁", "▂"] as const;

/** The remains a fire leaves in a place `width` cells wide at `now`; `still` holds them on one moment. */
export function leave(settings: Remains, width: number, now: number, still: boolean): Remnant {
  const random = seeded(17);
  const remnant: Remnant = {
    settings,
    start: now,
    next: now,
    held: still ? now + HELD_MS : null,
    coals:
      settings.coals === "none"
        ? []
        : bank(width, { cooling: settings.coals === "glowing" ? Infinity : settings.cooling }),
    bed: Array.from({ length: width }, () => (random() < 0.3 ? 2 : 1)),
    smoke: settings.smoke > 0 ? plume(width, SMOKE_ROWS, settings.smoke) : null,
    thrown: settings.sparks > 0 ? cinders(width, Math.max(1, width * settings.sparks)) : [],
    pilot: settings.pilot
      ? warm(
          kindle(PILOT_COLUMNS, 8, {
            fuel: flame,
            intensity: 0.75,
            reach: 0.9,
            turbulence: 0.25,
            flicker: 0.25,
            flickerRate: 0.2,
            point: 0.6,
            sparks: 0,
            seed: 9,
          }),
        )
      : null,
  };
  if (still) for (let elapsed = 0; elapsed <= HELD_MS; elapsed += STEP_MS) step(remnant, elapsed);
  return remnant;
}

function step(remnant: Remnant, elapsed: number): void {
  if (remnant.smoke) billow(remnant.smoke, elapsed);
  if (remnant.pilot) stoke(remnant.pilot);
}

/** Milliseconds since the remains were left, as a draw at `now` shows them. */
const age = (remnant: Remnant, now: number) => (remnant.held ?? now) - remnant.start;

/** Steps the smoke and the pilot when their step is due at `now`. */
export function tend(remnant: Remnant, now: number): void {
  if (remnant.held !== null || now < remnant.next) return;
  remnant.next = now + STEP_MS;
  step(remnant, now - remnant.start);
}

/** How warm the place's fill still is, 0..1. */
function warmth(remnant: Remnant, elapsed: number): number {
  if (remnant.settings.warmth === "none") return 0;
  return remnant.settings.warmth === "lasting" ? LASTING : Math.exp(-elapsed / (FADING_MS / 3));
}

const pilotAt = (place: Place) => place.x + Math.floor(place.width / 2) - 1;

/** The light the remains give off at `now`, in screen cells, from the coals, sparks, warmth, and pilot. */
export function remnantLights(remnant: Remnant, place: Place, now: number): Light[] {
  const elapsed = age(remnant, now);
  const shift = (x: number) => (light: Light) => ({ ...light, x: light.x + x, y: light.y + place.y });
  const out = [
    ...coalLights(remnant.coals, elapsed).map(shift(place.x)),
    ...cinderLights(remnant.thrown, elapsed).map(shift(place.x)),
  ];
  const warm = warmth(remnant, elapsed);
  if (warm > 0) {
    const colour = linear(glow(0.42));
    for (let column = 0; column < place.width; column++)
      out.push({ x: place.x + column + 0.5, y: place.y + 0.85, colour, power: 0.12 * warm });
  }
  if (remnant.pilot)
    out.push(...lights(remnant.pilot, "eighths", PILOT_COLUMNS, 1, PILOT).map(shift(pilotAt(place))));
  return out;
}

const CLEAR = RGBA.fromInts(0, 0, 0, 0);

/** The fill of cell `x`, `y` as `#rrggbb`. */
function fillAt(buffer: OptimizedBuffer, x: number, y: number): string {
  const at = (y * buffer.width + x) * 4;
  const bg = buffer.buffers.bg;
  const byte = (offset: number) => ((bg[at + offset] ?? 0) & 0xff).toString(16).padStart(2, "0");
  return `#${byte(0)}${byte(1)}${byte(2)}`;
}

/** Draws `char` in `fg` over cell `x`, `y`, keeping its fill. */
function mark(buffer: OptimizedBuffer, x: number, y: number, char: string, fg: string): void {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  buffer.setCellWithAlphaBlending(x, y, char, RGBA.fromHex(fg), CLEAR);
}

/** Blends the fill of cell `x`, `y` toward `colour` by `t`, keeping its metadata. */
function warmFill(buffer: OptimizedBuffer, x: number, y: number, colour: string, t: number): void {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  const value = Number.parseInt(mix(fillAt(buffer, x, y), colour, t).slice(1), 16);
  const bg = buffer.buffers.bg;
  const at = (y * buffer.width + x) * 4;
  [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].forEach((channel, offset) => {
    bg[at + offset] = ((bg[at + offset] ?? 0) & 0xff00) | channel;
  });
}

/** Draws the remains into `place` and the rows above it, as they are at `now`. */
export function drawRemnant(buffer: OptimizedBuffer, remnant: Remnant, place: Place, now: number): void {
  const { settings } = remnant;
  const elapsed = age(remnant, now);
  const warm = warmth(remnant, elapsed);
  if (warm > 0)
    for (let column = 0; column < place.width; column++)
      warmFill(buffer, place.x + column, place.y, EMBER, 0.45 * warm);
  for (let column = 0; column < place.width; column++) {
    const x = place.x + column;
    const coal = remnant.coals[column];
    const glowing = coal ? smoulder(coal, elapsed) : null;
    if (glowing && glowing.gone < 1) {
      // A coal cooling to ash greys as it goes out; one winking out fades into its fill.
      const end = settings.coals === "ash" ? ASH : fillAt(buffer, x, place.y);
      mark(buffer, x, place.y, glowing.char, coalColour(glowing, end));
    } else if (glowing && settings.coals === "ash") {
      mark(buffer, x, place.y, glowing.char, ASH);
    } else if (settings.ash) {
      mark(buffer, x, place.y, ASH_RISE[(remnant.bed[column] ?? 1) - 1] ?? ASH_RISE[0], ASH);
    }
  }
  if (remnant.pilot) {
    const left = pilotAt(place);
    paint(remnant.pilot, "eighths", PILOT_COLUMNS, 1).forEach((cell, column) => {
      if (cell) mark(buffer, left + column, place.y, cell.char, glow(cell.fg, PILOT));
    });
  }
  if (remnant.smoke) {
    for (const puff of puffs(remnant.smoke)) {
      const x = place.x + puff.x;
      const y = place.y + puff.y;
      if (y < 0) continue;
      mark(buffer, x, y, puff.char, glow(puff.density, smokeRamp(fillAt(buffer, x, y))));
    }
  }
  for (const cinder of remnant.thrown) {
    const at = flight(cinder, elapsed);
    if (!at) continue;
    const y = place.y + Math.round(at.y - 0.5);
    // Sparks show once they have left the coals' row.
    if (y >= place.y) continue;
    mark(buffer, place.x + Math.round(at.x - 0.5), y, at.char, glow(at.heat));
  }
}
