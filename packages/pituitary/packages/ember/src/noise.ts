/**
 * Smooth value noise in two dimensions, 0..1, the same for the same seed.
 *
 * Lattice points carry hashed values and the space between eases from one to the next,
 * so neighbouring samples differ a little and distant ones independently: the texture
 * of turbulence, where a per-pixel random draw is only static.
 */
export type Noise = (x: number, y: number) => number;

export function noise(seed: number): Noise {
  const salt = Math.imul(seed | 0, 0x27d4eb2d) >>> 0;
  const lattice = (x: number, y: number): number => {
    let h = (Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5bd1e995) ^ salt) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = ease(x - x0);
    const fy = ease(y - y0);
    const top = lerp(lattice(x0, y0), lattice(x0 + 1, y0), fx);
    const bottom = lerp(lattice(x0, y0 + 1), lattice(x0 + 1, y0 + 1), fx);
    return lerp(top, bottom, fy);
  };
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
