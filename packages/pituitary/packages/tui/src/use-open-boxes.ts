import { useCallback, useState } from "react";
import type { Work } from "./transcript.ts";

/** How each box the operator opened, closed or pinned at full length shows, until ctrl+o sets every box one way. */
interface Pins {
  /** How many times ctrl+o had set every box one way when these were set. */
  after: number;
  open: ReadonlyMap<string, boolean>;
  full: ReadonlyMap<string, boolean>;
  /** The box the operator opened last, which may take the rows the conversation leaves empty. */
  last: string | null;
}

const unpinned = (after: number): Pins => ({ after, open: new Map(), full: new Map(), last: null });

/**
 * Which boxes are open, and which at full length: every one when `whole`, and any the operator
 * opened, closed or pinned at full length since ctrl+o last set every box one way, which it has
 * done `expansions` times. A box the model works in shows its latest steps folded rather than
 * opening.
 */
export function useOpenBoxes(whole: boolean, expansions: number) {
  const [pins, setPins] = useState<Pins>(() => unpinned(expansions));
  const current = pins.after === expansions ? pins : unpinned(expansions);
  const isOpen = (work: Work) => current.open.get(work.id) ?? whole;
  const isWhole = (work: Work) => current.full.get(work.id) ?? whole;
  const pin = useCallback(
    (change: (pins: Pins) => Pins) =>
      setPins((before) => change(before.after === expansions ? before : unpinned(expansions))),
    [expansions],
  );
  const toggle = useCallback(
    (id: string, open: boolean) =>
      pin((before) => ({
        ...before,
        open: new Map(before.open).set(id, open),
        last: open ? id : before.last,
      })),
    [pin],
  );
  /** Opens `work` at full length, or bounds it again when it already is. */
  const stretch = (work: Work) =>
    pin((before) => ({
      ...before,
      open: new Map(before.open).set(work.id, true),
      full: new Map(before.full).set(work.id, !(isOpen(work) && isWhole(work))),
      last: work.id,
    }));
  const last = current.last && current.open.get(current.last) ? current.last : null;
  return { isOpen, isWhole, toggle, stretch, last };
}
