import { createHash } from "node:crypto";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

/** Public decimal IDs preserve the Harness's allocation; no application counter exists. */
function numericId(value: string | number): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0 || String(id) !== String(value))
    throw new Error("Invalid native record identity");
  return id;
}
export const nativeConversation = (value: string | number) => numericId(value) as ConversationId;
export const nativeTask = <R = unknown>(value: string | number) => numericId(value) as TaskId<R>;

/** Native IDs are scoped to one Harness. Bay names must also distinguish independent databases. */
export function baySessionName(namespace: string, kind: "agent" | "verify", id: string): string {
  const key = createHash("sha256").update(`${namespace}:${kind}:${id}`).digest("hex").slice(0, 40);
  return `dura-${kind}-${key}`;
}
