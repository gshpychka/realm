import { approach, settled } from "./ease.ts";

/**
 * How close the surface is held to the lattice.
 *
 * `NEAR` is one pane filling the viewport. `FAR` is every pane at once. The values
 * between are a real scale, so widening out and closing in is one movement rather
 * than a switch between two views.
 */
export interface Zoom {
  scale: number;
  target: number;
}

export const NEAR = 1;
export const FAR = 0;

/** Below this the surface stops asking panes for detail. */
export const DETAIL = 0.72;

export function zoom(at: number = NEAR): Zoom {
  return { scale: clamp(at), target: clamp(at) };
}

export function to(current: Zoom, target: number): Zoom {
  return { ...current, target: clamp(target) };
}

export function toggle(current: Zoom): Zoom {
  return to(current, current.target === NEAR ? FAR : NEAR);
}

export function ease(current: Zoom): Zoom {
  return settled(current.scale, current.target)
    ? current
    : { ...current, scale: approach(current.scale, current.target) };
}

export function steady(current: Zoom): boolean {
  return settled(current.scale, current.target);
}

/** True while the surface is close enough that detail is worth drawing. */
export function detailed(current: Zoom, threshold = DETAIL): boolean {
  return current.scale > threshold;
}

function clamp(scale: number): number {
  return Math.min(NEAR, Math.max(FAR, scale));
}
