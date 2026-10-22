/**
 * The side channel between pituitary and the bridge extension it loads into pi.
 *
 * pi's RPC mode renders no component an extension hands to `ctx.ui.custom()`; the bridge
 * runs such a component inside pi and streams what it draws to pituitary, which sends the
 * operator's keys back. Records are JSON, one per LF-terminated line.
 */

import { StringDecoder } from "node:string_decoder";

/** Environment variable naming the socket pituitary listens on. */
export const BRIDGE_SOCKET_ENV = "PITUITARY_BRIDGE";

/** Environment variable carrying the secret a connection proves it came from pituitary's own pi with. */
export const BRIDGE_TOKEN_ENV = "PITUITARY_BRIDGE_TOKEN";

/** Environment variable carrying a command stock pi should offer in its editor after a handoff. */
export const HANDOFF_ENV = "PITUITARY_HANDOFF";

/** Environment variable naming the file stock pi writes its final session path to after a handoff. */
export const HANDOFF_RESULT_ENV = "PITUITARY_HANDOFF_RESULT";

/** Prefix of the commands the bridge registers for pituitary's own use. */
export const BRIDGE_COMMAND_PREFIX = "pituitary-";

/** What the bridge tells pituitary. */
export type BridgeMessage =
  /** The first record of a connection; pituitary drops a connection whose token differs. */
  | { type: "hello"; token: string }
  /** A custom component opened and takes the keyboard until it closes. */
  | { type: "open"; id: string }
  /** The component's latest drawing, one ANSI-styled string per row. */
  | { type: "frame"; id: string; lines: string[] }
  | { type: "close"; id: string }
  /** The usage-limit headers of pi's latest provider response, and nothing else from it. */
  | { type: "limits"; headers: Record<string, string> };

/** What pituitary tells the bridge. */
export type HostMessage =
  /** pituitary accepted the connection's token. */
  | { type: "welcome" }
  /** The cells a component may draw into. */
  | { type: "size"; columns: number; rows: number }
  /** A key or paste, as the terminal sent it. */
  | { type: "input"; id: string; data: string }
  /** The operator dismissed the component; its `custom()` call resolves with nothing. */
  | { type: "cancel"; id: string };

export function encodeRecord(message: BridgeMessage | HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into records, calling `onRecord` with each parsed one. A character
 * whose bytes straddle two chunks is held until its last byte arrives.
 */
export function recordReader<T>(onRecord: (record: T) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let end = pending.indexOf("\n");
    while (end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) {
        try {
          onRecord(JSON.parse(line) as T);
        } catch {
          // A record that fails to parse carries nothing either side can act on.
        }
      }
      end = pending.indexOf("\n");
    }
  };
}
