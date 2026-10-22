/**
 * The approach every moving value shares: a fraction of the remaining distance per
 * step, snapping at the end so a value lands exactly on its target.
 *
 * Exactness matters more than smoothness here. A value that only approaches its
 * target leaves the caller with no way to ask whether movement has finished.
 *
 * The snap is an absolute distance, so a wider gap takes more steps to close.
 */

const RATE = 0.34;

/** Closer than this counts as arrived, in the value's own units. */
const SNAP = 0.004;

export function approach(current: number, target: number): number {
  if (current === target) return target;
  const next = current + (target - current) * RATE;
  return Math.abs(target - next) <= SNAP ? target : next;
}

export function settled(current: number, target: number): boolean {
  return current === target;
}
