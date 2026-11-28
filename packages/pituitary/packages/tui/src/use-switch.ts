import { useCallback, useRef, useState } from "react";

/** A setting a key flips: whether it is on, and how many times it has been flipped. */
export interface Switch {
  on: boolean;
  flips: number;
}

/**
 * A setting the operator flips with a key, from `initial`. `flip` sets it the other way and
 * returns how it set it. Presses that arrive together, faster than the screen redraws, each flip
 * it from where the one before left it, as the value of the last frame would not.
 */
export function useSwitch(initial: boolean): Switch & { flip(): boolean } {
  const [state, setState] = useState<Switch>({ on: initial, flips: 0 });
  const latest = useRef(state);
  const flip = useCallback(() => {
    const next = { on: !latest.current.on, flips: latest.current.flips + 1 };
    latest.current = next;
    setState(next);
    return next.on;
  }, []);
  return { ...state, flip };
}
