import { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { EditorHandle } from "./components/editor.tsx";

/** A key that types one character into the draft, which the app never acts on. */
function typed(key: KeyEvent): boolean {
  return !key.ctrl && !key.meta && [...key.sequence].length === 1 && !/\p{Cc}/u.test(key.sequence);
}

/**
 * Hands each key to `onKey`, and a key it leaves untaken to the draft. A key the app acts on
 * reads the draft, so while `holding` one arriving before the draft shows the keys typed ahead
 * of it waits for them, and every key after it waits behind it.
 */
export function useHeldKeys(
  editor: RefObject<EditorHandle | null>,
  onKey: (key: KeyEvent) => void,
  holding: boolean,
  /** A newly opened extension dialog or component must not receive keys meant for the draft. */
  boundary: object | null = null,
): void {
  const held = useRef<{ key: KeyEvent; boundary: object | null }[]>([]);
  const replaying = useRef(false);
  const mounted = useRef(true);
  const renderer = useRenderer();
  const [released, release] = useState(0);
  const latest = useRef(onKey);
  latest.current = onKey;
  const hold = () =>
    void editor.current?.settle().then(() => {
      if (mounted.current) release((count) => count + 1);
    });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      held.current = [];
    };
  }, []);

  useKeyboard((key) => {
    if (replaying.current) {
      latest.current(key);
      return;
    }
    const waiting = held.current.length > 0 || (!typed(key) && editor.current?.busy());
    if (!waiting || !holding) {
      onKey(key);
      return;
    }
    key.preventDefault();
    held.current.push({ key, boundary });
    if (held.current.length === 1) hold();
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a held key is released
  useEffect(() => {
    const next = held.current[0];
    if (!next) return;
    if (editor.current?.busy()) {
      hold();
      return;
    }
    held.current.shift();
    if (next.boundary === boundary) {
      // Holding the key took it; a fresh copy says whether the app takes it now.
      const replay = new KeyEvent(next.key);
      // A shortcut may have opened a picker. Route through the same global handlers
      // and focused input, while an unrelated extension dialog drops the old input.
      replaying.current = true;
      try {
        renderer.keyInput.emit("keypress", replay);
      } finally {
        replaying.current = false;
      }
    }
    if (held.current.length > 0) release((count) => count + 1);
  }, [released]);
}
