import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OptimizedBuffer } from "@opentui/core";
import type { RpcSessionState } from "@pituitary/rpc";
import { tilde } from "../place.ts";
import type { CommandContext } from "./run-command.ts";

/** The rows of `buffer` as plain text, each without its trailing blanks. */
export function frameRows(buffer: OptimizedBuffer): string[] {
  const text = new TextDecoder().decode(buffer.getRealCharBytes(true));
  return text
    .split("\n")
    .slice(0, buffer.height)
    .map((row) => row.trimEnd());
}

export interface DebugSnapshot {
  at: Date;
  columns: number;
  rows: number;
  /** The frame on the terminal, one string per row. */
  screen: string[];
  state: RpcSessionState;
  messages: readonly unknown[];
}

/** The debug log's text: the frame on the terminal, the session state, and the agent messages as JSONL. */
export function debugLog(snapshot: DebugSnapshot): string {
  return [
    `Debug output at ${snapshot.at.toISOString()}`,
    `Terminal: ${snapshot.columns}x${snapshot.rows}`,
    "",
    "=== Screen ===",
    ...snapshot.screen.map((row, index) => `[${index}] ${JSON.stringify(row)}`),
    "",
    "=== Session state ===",
    JSON.stringify(snapshot.state, null, 2),
    "",
    "=== Agent messages (JSONL) ===",
    ...snapshot.messages.map((message) => JSON.stringify(message)),
    "",
  ].join("\n");
}

/** Where `/debug` writes, beside pi's own debug log in pi's agent directory. */
export async function debugLogPath(): Promise<string> {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return join(getAgentDir(), "pituitary-debug.log");
}

/** Writes `text` to `path`, readable by the operator alone: it holds the conversation. */
export function writeDebugLog(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Writes the debug log for the moment it is asked for, and tells the operator where it went. */
export async function writeDebug({ link, session, screen }: CommandContext): Promise<void> {
  const rows = screen();
  const [state, { messages }] = await Promise.all([
    link.call({ type: "get_state" }),
    link.call({ type: "get_messages" }),
  ]);
  const path = await debugLogPath();
  const at = new Date();
  const { columns = 0, rows: height = 0 } = process.stdout;
  writeDebugLog(path, debugLog({ at, columns, rows: height, screen: rows, state, messages }));
  session.notify("info", `wrote the debug log to ${tilde(path)}`);
}
