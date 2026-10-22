/**
 * How much fuel lies under each point of the hearth.
 *
 * `u` runs 0..1 across the width and `tick` counts steps, so a bed can move or breathe.
 * The result is the heat that point feeds upward, 0..1.
 */
export type Fuel = (u: number, tick: number) => number;

/** The whole width burns alike. */
export const even: Fuel = () => 1;

/** Full at the centre, falling to nothing at both margins. */
export const arch: Fuel = (u) => Math.sin(Math.PI * clamp(u));

/** Hottest at the centre with the margins still lit, the bed of a small flame. */
export const flame: Fuel = (u) => 0.6 + 0.4 * Math.sin(Math.PI * clamp(u));

/** Hot at the start of the width, going out towards the end. */
export const cooling: Fuel = (u) => (1 - clamp(u)) ** 1.3;

/** A hot zone drifting along the width over `period` steps, over a low bed. */
export function travelling(period = 90, floor = 0.35): Fuel {
  return (u, tick) => {
    const centre = (tick / period) % 1;
    const distance = Math.min(Math.abs(u - centre), 1 - Math.abs(u - centre));
    return floor + (1 - floor) * Math.exp(-((distance / 0.12) ** 2));
  };
}

/** Two beds, at a quarter and three quarters of the width. */
export const twin: Fuel = (u) => Math.max(bump(u, 0.25, 0.22), bump(u, 0.75, 0.22));

/** Fuel on the first `share` of the width, its edge breathing back and forth. */
export function lit(share = 0.5, breath = 0.06, period = 70): Fuel {
  return (u, tick) => {
    const edge = share + breath * Math.sin((2 * Math.PI * tick) / period);
    return clamp((edge - u) / 0.06 + 0.5);
  };
}

/** `fuel` held to `strength`, for a fire that burns lower overall. */
export function banked(fuel: Fuel, strength: number): Fuel {
  return (u, tick) => fuel(u, tick) * strength;
}

function bump(u: number, centre: number, half: number): number {
  const distance = Math.abs(u - centre) / half;
  return distance >= 1 ? 0 : Math.cos((Math.PI / 2) * distance);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
