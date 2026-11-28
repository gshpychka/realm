import { useCallback, useState } from "react";
import type { Work } from "./transcript.ts";

/** How each box the operator opened, closed or pinned at full length shows, until ctrl+o sets every box one way. */
interface Pins {
  /** Whether every box was open at full length when these were set. */
  whole: boolean;
  open: ReadonlyMap<string, boolean>;
  full: ReadonlyMap<string, boolean>;
  /** The box the operator opened last, which may take the rows the conversation leaves empty. */
  last: string | null;
}

const UNPINNED: Pins = { whole: false, open: new Map(), full: new Map(), last: null };

/**
 * Which boxes are open, and which at full length: every one when `whole`, and any the operator
 * opened, closed or pinned at full length, until `whole` changes. A box the model works in
 * shows its latest steps folded rather than opening.
 */
export function useOpenBoxes(whole: boolean) {
  const [pins, setPins] = useState<Pins>({ ...UNPINNED, whole });
  const current = pins.whole === whole ? pins : { ...UNPINNED, whole };
  const isOpen = (work: Work) => current.open.get(work.id) ?? whole;
  const isWhole = (work: Work) => current.full.get(work.id) ?? whole;
  const pin = useCallback(
    (change: (pins: Pins) => Pins) =>
      setPins((before) => change(before.whole === whole ? before : { ...UNPINNED, whole })),
    [whole],
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
