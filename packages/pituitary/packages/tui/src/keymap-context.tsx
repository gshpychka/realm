import { createContext, useContext } from "react";
import { ACTIONS, type Action, type Keymap } from "./keymap.ts";

const KeymapContext = createContext<Keymap>(ACTIONS);
export const KeymapProvider = KeymapContext.Provider;

/** The same bindings the app dispatches, with defaults for isolated components. */
export function useKeymap(): Keymap {
  return useContext(KeymapContext);
}

export function keyHint(bindings: Keymap, action: Action): string | null {
  const keys = bindings[action].map((key) => key.replaceAll("escape", "esc"));
  return keys.length > 0 ? keys.join(" / ") : null;
}

export function useKeyHint(action: Action): string | null {
  return keyHint(useKeymap(), action);
}

/** An inline action hint disappears when the operator unbinds that action. */
export function KeyHint({ action }: { action: Action }) {
  const hint = useKeyHint(action);
  return hint ? ` · ${hint}` : null;
}
