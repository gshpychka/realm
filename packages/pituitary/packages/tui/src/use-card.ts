import type { ConversationLink } from "@pituitary/session";
import { useState } from "react";
import type { UsageDisplay } from "./usage/types.ts";
import type { SessionController } from "./use-session.ts";

/** The footer's card, and what opens and closes it from the keyboard or a click. */
export interface Card {
  open: boolean;
  toggle(): void;
  /** Closes the card; false when it was closed already. */
  close(): boolean;
}

/**
 * The footer's card: provider usage while Pi's usage extension reports it, which its `/usage`
 * command opens and closes, and the session's cost otherwise, which the frontend keeps itself.
 */
export function useCard(
  usage: UsageDisplay | undefined,
  link: ConversationLink,
  notify: SessionController["notify"],
): Card {
  const [own, setOwn] = useState(false);
  const open = usage ? usage.open : own;
  const set = (next: boolean) => {
    if (!usage) setOwn(next);
    else
      void link.prompt(next ? "/usage on" : "/usage off").catch((error) => notify("warning", String(error)));
  };
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
