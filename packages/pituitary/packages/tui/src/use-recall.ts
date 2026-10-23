import type { KeyEvent } from "@opentui/core";
import type { Entry } from "@pituitary/session";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { EditorHandle } from "./components/editor.tsx";
import { fresh, newer, older, prompts, type Recall } from "./history.ts";

/**
 * A step out of the draft that the next up takes at once: asked for by a first press, or
 * continuing a run of steps through earlier prompts.
 */
export interface Offer {
  kind: "queue" | "history";
  /** The draft the offer stands on; the draft changing withdraws it. */
  text: string;
  /** What the second press does, shown while the offer waits on it. */
  asking: string | null;
}

/** Plain up, which also walks the draft's rows, so leaving the draft on it takes a second press. */
export function walksDraft(key: KeyEvent): boolean {
  return key.name === "up" && !key.ctrl && !key.meta && !key.shift;
}

export type Offers = ReturnType<typeof useOffers>;

/**
 * The offers that make leaving the draft take two presses. One stands only while the draft
 * holds the keyboard, which `away` takes from it, and one for the queue only while `queued`
 * is above 0; a change to the draft withdraws it.
 */
export function useOffers({ away, queued }: { away: boolean; queued: number }) {
  const [offer, show] = useState<Offer | null>(null);
  const standing = useRef<Offer | null>(null);
  const set = useCallback((next: Offer | null) => {
    standing.current = next;
    show(next);
  }, []);

  useEffect(() => {
    if (away || (queued === 0 && standing.current?.kind === "queue")) set(null);
  }, [away, queued, set]);

  /** True once the operator has asked for `kind` twice running; the first ask shows `asking` and waits. */
  const confirmed = (kind: Offer["kind"], before: Offer | null, text: string, asking: string): boolean => {
    if (before?.kind === kind) return true;
    set({ kind, text, asking });
    return false;
  };

  return {
    /** What a second press does, while an offer waits on one. */
    asking: offer?.asking ?? null,
    /** The offer standing as a key arrives; every key passes it up, and a step out of the draft renews it. */
    take(): Offer | null {
      const taken = standing.current;
      if (taken) set(null);
      return taken;
    },
    confirmed,
    /** Lets further steps through earlier prompts go on at once, from `text`. */
    continuing(text: string): void {
      set({ kind: "history", text, asking: null });
    },
    edited(text: string): void {
      if (standing.current && text !== standing.current.text) set(null);
    },
  };
}

/** The prompts the operator sent and the commands they ran, oldest first, as up recalls them. */
function historyOf(entries: readonly Entry[]): string[] {
  return prompts(
    entries.flatMap((entry) => {
      if (entry.kind === "user") return [entry.text];
      return [];
    }),
  );
}

/** Up and down through the operator's earlier prompts, from the draft's top and bottom rows. */
export function useRecall(editor: RefObject<EditorHandle | null>, entries: readonly Entry[], offers: Offers) {
  const recall = useRef<Recall>(fresh);
  const recalled = useRef<string | null>(null);

  /** Starts recall afresh from the draft, as sending it does. */
  const forget = () => {
    recall.current = fresh;
    recalled.current = null;
  };

  const step = (next: { recall: Recall; text: string }) => {
    recall.current = next.recall;
    recalled.current = next.recall.index === null ? null : next.text;
    // Further on goes at once until another key breaks the run; back on the operator's own
    // draft, leaving it again takes two presses.
    if (next.recall.index !== null) offers.continuing(next.text);
    editor.current?.set(next.text);
  };

  return {
    /** Steps back to an earlier prompt from `text`; false when there is none. */
    back(key: KeyEvent, text: string, standing: Offer | null): boolean {
      const earlier = older(recall.current, historyOf(entries), text);
      if (!earlier) return false;
      const asked =
        !walksDraft(key) || offers.confirmed("history", standing, text, "↑ again for the previous prompt");
      if (asked) step(earlier);
      return true;
    },
    /** Steps forward to a later prompt, and at the end back to the operator's own draft; false when already there. */
    forward(): boolean {
      const later = newer(recall.current, historyOf(entries));
      if (later) step(later);
      return later !== null;
    },
    /** Takes the draft as it changes: editing a recalled prompt makes it the operator's own. */
    edited(text: string): void {
      if (recalled.current !== null && text !== recalled.current) forget();
    },
    forget,
  };
}
