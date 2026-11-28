/**
 * Pituitary's own channel into Pi, for what Pi's RPC lacks: listing and managing saved
 * sessions, and reloading resources. The frontend sends a request as the arguments of the
 * bridge extension's command, and the extension answers through a status that the frontend
 * takes out of the stream before any extension UI sees it. Both sides share this module,
 * so it imports nothing.
 */

/**
 * The command the bridge extension registers. Pi renames commands that share a name
 * (`pituitary:1`, `pituitary:2`), and an unknown `/name` reaches the model as a prompt, so the
 * frontend finds the command by its extension's file instead of assuming this name.
 */
export const BRIDGE_COMMAND = "pituitary";
/** The status key the bridge answers through. It never reaches the extension UI. */
export const BRIDGE_STATUS = "pituitary.bridge";
/**
 * The status key that marks a Pi runtime: set to its `RuntimeMark` when the runtime starts,
 * cleared when it ends. Pi replaces its runtime for new, forked, resumed and reloaded sessions.
 */
export const RUNTIME_STATUS = "pituitary.runtime";

/** A saved session, as the resume picker shows it. */
export interface SessionSummary {
  path: string;
  id: string;
  /** Where the session was started; empty for sessions saved before Pi recorded it. */
  cwd: string;
  name?: string;
  /** The session this one was forked from. */
  parent?: string;
  /** When the session last changed, in milliseconds since the epoch. */
  modified: number;
  /** The prompts the operator sent in it, on every branch. */
  prompts: number;
  /** The session's first prompt. */
  first: string;
}

/** What each kind of request carries, and what its reply holds. */
export interface BridgeKinds {
  /** This project's saved sessions, or every project's. */
  sessions: { request: { all: boolean }; result: { sessions: SessionSummary[] } };
  "rename-session": { request: { path: string; name: string }; result: null };
  /** Refused for the session Pi has open; `trashed` when a `trash` command took the file rather than deleting it for good. */
  "delete-session": { request: { path: string }; result: { trashed: boolean } };
  /** Reloads extensions, skills, prompts, themes and context files. */
  reload: { request: Record<never, never>; result: null };
}
export type BridgeKind = keyof BridgeKinds;
export type BridgeRequest<K extends BridgeKind = BridgeKind> = K extends BridgeKind
  ? { kind: K } & BridgeKinds[K]["request"]
  : never;
export type BridgeResult<K extends BridgeKind> = BridgeKinds[K]["result"];
/** A request as sent, with the id its reply carries. */
export type BridgeCall = BridgeRequest & { id: string };
export type BridgeReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
/** What a runtime's start reports. */
export interface RuntimeMark {
  cwd: string;
  /**
   * What each of the runtime's prompt templates takes, by name, as its `argument-hint`
   * frontmatter declares it, such as `<focus>`; Pi's RPC command list leaves the hint out.
   */
  argumentHints: Record<string, string>;
}

/** A request that cannot be read; `id` is present when the reply can still name its request. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly id?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const encodeCall = (call: BridgeCall): string => JSON.stringify(call);
export const encodeReply = (reply: BridgeReply): string => JSON.stringify(reply);
export const encodeRuntime = (mark: RuntimeMark): string => JSON.stringify(mark);

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The request `args` hold, validated by kind; throws a `BridgeError` for anything else. */
export function decodeCall(args: string): BridgeCall {
  const value = parse(args.trim());
  if (!isFields(value)) throw new BridgeError("The bridge request is not a JSON object.");
  const id = text(value.id) ? value.id : undefined;
  if (!id) throw new BridgeError("The bridge request has no id.");
  const fail = (message: string): never => {
    throw new BridgeError(message, id);
  };
  switch (value.kind) {
    case "sessions":
      if (typeof value.all !== "boolean") fail("sessions needs `all`.");
      return { id, kind: "sessions", all: value.all as boolean };
    case "rename-session": {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (!text(value.path) || !name) fail("rename-session needs a path and a name.");
      return { id, kind: "rename-session", path: value.path as string, name };
    }
    case "delete-session":
      if (!text(value.path)) fail("delete-session needs a path.");
      return { id, kind: "delete-session", path: value.path as string };
    case "reload":
      return { id, kind: "reload" };
    default:
      return fail(`Unknown bridge request: ${String(value.kind)}`);
  }
}

/** The reply a bridge status carries; undefined when it is not one. */
export function decodeReply(status: string | undefined): BridgeReply | undefined {
  const value = status === undefined ? undefined : parse(status);
  if (!isFields(value) || !text(value.id)) return;
  if (value.ok === true) return { id: value.id, ok: true, result: value.result ?? null };
  if (value.ok === false) return { id: value.id, ok: false, error: String(value.error ?? "failed") };
}

/** The runtime mark a status carries, keeping only hints that are text; undefined when it is not one. */
export function decodeRuntime(status: string | undefined): RuntimeMark | undefined {
  const value = status === undefined ? undefined : parse(status);
  if (!isFields(value) || !text(value.cwd)) return undefined;
  const hints = isFields(value.argumentHints) ? Object.entries(value.argumentHints) : [];
  return {
    cwd: value.cwd,
    argumentHints: Object.fromEntries(hints.filter((hint): hint is [string, string] => text(hint[1]))),
  };
}

/** The reply's result in the shape `kind` answers with, dropping anything that is not. */
export function readResult<K extends BridgeKind>(kind: K, result: unknown): BridgeResult<K> {
  switch (kind) {
    case "sessions": {
      const sessions = isFields(result) && Array.isArray(result.sessions) ? result.sessions : [];
      return { sessions: sessions.filter(isSummary) } as BridgeResult<K>;
    }
    case "delete-session":
      return { trashed: isFields(result) && result.trashed === true } as BridgeResult<K>;
    default:
      return null as BridgeResult<K>;
  }
}

function isSummary(value: unknown): value is SessionSummary {
  return (
    isFields(value) &&
    text(value.path) &&
    text(value.id) &&
    typeof value.cwd === "string" &&
    typeof value.modified === "number" &&
    typeof value.prompts === "number" &&
    typeof value.first === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.parent === undefined || typeof value.parent === "string")
  );
}
