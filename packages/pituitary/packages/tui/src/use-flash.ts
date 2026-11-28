import { useCallback, useState } from "react";

/** How long a passing hint stays, unless it asks for longer. */
const HINT_MS = 2000;

/**
 * A passing hint, and the call that shows one for `ms`; a later hint takes its place. The call
 * returns what takes the hint down early, once what it says no longer holds.
 */
export function useFlash(): [hint: string | null, flash: (text: string, ms?: number) => () => void] {
  const [hint, setHint] = useState<string | null>(null);
  const flash = useCallback((text: string, ms = HINT_MS) => {
    setHint(text);
    const dismiss = () => setHint((current) => (current === text ? null : current));
    setTimeout(dismiss, ms);
    return dismiss;
  }, []);
  return [hint, flash];
}
