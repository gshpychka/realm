import { useState } from "react";
import type { UsageDisplay } from "./usage/types.ts";

/** The footer's card, and what opens and closes it from the keyboard or a click. */
export interface Card {
  open: boolean;
  toggle(): void;
  /** Closes the card; false when it was closed already. */
  close(): boolean;
}

/**
 * The footer's card: provider usage while Pi's usage extension reports it, which `show` opens
 * and closes through the extension's command, and the session's cost otherwise, which the
 * frontend keeps itself.
 */
export function useCard(usage: UsageDisplay | undefined, show: ((open: boolean) => void) | undefined): Card {
  const [own, setOwn] = useState(false);
  const reported = usage && show ? { usage, show } : undefined;
  const open = reported ? reported.usage.open : own;
  const set = (next: boolean) => (reported ? reported.show(next) : setOwn(next));
  return {
    open,
    toggle: () => set(!open),
    close: () => {
      if (!open) return false;
      set(false);
      return true;
    },
  };
}
