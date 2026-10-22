import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  SessionStats,
} from "@earendil-works/pi-coding-agent";

export type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  SessionStats,
};

/** Emitted when an extension throws, which RPC mode reports outside the session event union. */
export interface ExtensionErrorEvent {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
}

/**
 * Events pi emits on stdout in RPC mode.
 *
 * These are session events as they cross the wire: a `message_update` carries its delta
 * and the usage so far, without the message built up so far. RPC mode adds extension
 * failures on top of them.
 */
export type PiEvent = JsonAgentSessionEvent | ExtensionErrorEvent;

/** Every record pi writes to stdout. */
export type PiOutput = PiEvent | RpcResponse | RpcExtensionUIRequest;

/** What pi answers a command of type `T` with, once it succeeds. */
export type ResponseData<T extends RpcCommand["type"]> =
  Extract<RpcResponse, { command: T; success: true }> extends { data: infer D } ? D : undefined;

export function isRpcResponse(output: PiOutput): output is RpcResponse {
  return output.type === "response";
}

export function isExtensionUiRequest(output: PiOutput): output is RpcExtensionUIRequest {
  return output.type === "extension_ui_request";
}

/** Text carried by a `content` array, as used by messages and tool results. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block)
        return String((block as { text: unknown }).text);
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** An extension UI request that blocks the agent until the client answers it. */
export type DialogRequest = Extract<
  RpcExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

/** An extension UI request the agent sends and forgets. */
export type DisplayRequest = Exclude<RpcExtensionUIRequest, DialogRequest>;

export function isDialog(request: RpcExtensionUIRequest): request is DialogRequest {
  return (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  );
}

const SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this removes
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[ -/]*[0-~]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * `text` safe to put on the operator's terminal: escape sequences removed until none
 * remain, since removing one can join the pieces around it into another, then every
 * control character but newline and tab.
 *
 * Anything pi relays can carry them: styled extension text, model output, and the raw
 * bytes a tool read from a file.
 */
export function plain(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(SEQUENCE, "");
    if (next === current) break;
    current = next;
  }
  return current.replace(CONTROL, "");
}

/** `value` with every string inside it made `plain`. */
export function scrub<T>(value: T): T {
  if (typeof value === "string") return plain(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrub(entry);
    return out as T;
  }
  return value;
}
