import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Preserve the runtime connection when reconnecting from the operator's shell. */
export function attachCommand(
  name: string,
  {
    stateDirectory,
    taskId,
    socketPath,
  }: { stateDirectory?: string; taskId?: string; socketPath?: string } = {},
): string {
  return `dura attach ${shellWord(name)}${stateDirectory ? ` --state ${shellWord(stateDirectory)}` : ""}${taskId ? ` --task ${shellWord(taskId)}` : ""}${socketPath ? ` --socket ${shellWord(socketPath)}` : ""}`;
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface Log {
  write(chunk: string): void;
}

/**
 * Diagnostics sink.
 *
 * Anything written to the UI's own stdout or stderr lands in the rendered frame,
 * so the agent's stderr and any UI errors go to PITUITARY_LOG instead.
 */
export function openLog(): Log {
  const path = process.env.PITUITARY_LOG;
  if (!path) return { write: () => {} };
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return { write: () => {} };
  }
  return {
    write: (chunk) => {
      try {
        appendFileSync(path, chunk);
      } catch {
        // A failed diagnostic write must not take the UI down.
      }
    },
  };
}
