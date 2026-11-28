import { useCallback, useRef, useState } from "react";
import type { DialogRequest, DialogResponse } from "./components/dialog.tsx";

/** A question the frontend itself asks the operator, without an id: `ask` gives it one. */
export type Question = DistributiveOmit<DialogRequest, "type" | "id">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The frontend's own questions, such as a session's new name, asked one at a time in the
 * dialog area. `ask` resolves with the answer, or null when the operator cancels.
 */
export function useAsk() {
  const [open, setOpen] = useState<{ dialog: DialogRequest; settle(value: string | null): void }[]>([]);
  const next = useRef(0);
  const ask = useCallback(
    (question: Question) =>
      new Promise<string | null>((resolve) => {
        const dialog = { ...question, type: "dialog", id: `ask:${++next.current}` } as DialogRequest;
        setOpen((current) => [...current, { dialog, settle: resolve }]);
      }),
    [],
  );
  /** Takes the response to one of these questions; false when it answers another. */
  const answer = (response: DialogResponse): boolean => {
    const question = open.find(({ dialog }) => dialog.id === response.id);
    if (!question) return false;
    setOpen((current) => current.filter((each) => each !== question));
    question.settle(response.cancelled ? null : (response.value ?? ""));
    return true;
  };
  return { dialogs: open.map(({ dialog }) => dialog), ask, answer };
}
