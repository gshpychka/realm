import { createHash } from "node:crypto";
import {
  type AgentSnapshot,
  JsonLineDecoder,
  type PiEvent,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "@pituitary/rpc";
import type {
  DomainCommand,
  DomainRequest,
  DomainResult,
  InboxDelivery,
  WorkerAssignment,
} from "./domain-protocol.ts";

export type {
  DomainCommand,
  DomainRequest,
  DomainResult,
  InboxDelivery,
  InboxMessage,
  WorkerAssignment,
} from "./domain-protocol.ts";

export const WORKER_PROTOCOL_VERSION = 1;
/** A bounded live connection is disposable; the worker and its transcript are not. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_CLIENT_BACKLOG_BYTES = 2 * 1024 * 1024;

export const AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** Evaluated role data travels separately from the NixOS image and contains no credentials. */
export interface AgentManifest {
  schemaVersion: 1;
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  tools: AgentTool[];
  delegatesTo: string[];
  credentials: string[];
  /** Older saved roles omit limits; new declarations make their grants explicit. */
  limits?: { maxChildren: number; maxDepth: number };
}

export function validateAgentManifest(value: unknown): AgentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("agent manifest must be an object");
  const object = value as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(object)) > 2 * 1024 * 1024)
    throw new Error("agent manifest exceeds its byte limit");
  const keys = [
    "schemaVersion",
    "name",
    "description",
    "instructions",
    "model",
    "tools",
    "delegatesTo",
    "credentials",
    "limits",
  ];
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new Error("agent manifest contains an unknown field");
  const name = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  let limits: AgentManifest["limits"];
  if (object.limits !== undefined) {
    if (!object.limits || typeof object.limits !== "object" || Array.isArray(object.limits))
      throw new Error("agent limits must be an object");
    const declaration = object.limits as Record<string, unknown>;
    if (
      Object.keys(declaration).some((key) => !["maxChildren", "maxDepth"].includes(key)) ||
      !Number.isSafeInteger(declaration.maxChildren) ||
      (declaration.maxChildren as number) < 0 ||
      !Number.isSafeInteger(declaration.maxDepth) ||
      (declaration.maxDepth as number) < 0
    )
      throw new Error("agent limits must be non-negative safe integers");
    limits = { maxChildren: declaration.maxChildren as number, maxDepth: declaration.maxDepth as number };
  }
  if (object.schemaVersion !== 1) throw new Error("unsupported agent manifest version");
  if (typeof object.name !== "string" || !name.test(object.name))
    throw new Error("agent manifest has an invalid name");
  if (typeof object.description !== "string" || typeof object.instructions !== "string")
    throw new Error("agent description and instructions must be strings");
  if (Buffer.byteLength(object.description) + Buffer.byteLength(object.instructions) > 1024 * 1024)
    throw new Error("agent instructions exceed the manifest limit");
  if (object.model !== null && (typeof object.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(object.model)))
    throw new Error("agent model must be provider/model or null");
  const list = (
    key: "tools" | "delegatesTo" | "credentials",
    accepts: (item: string) => boolean,
  ): string[] => {
    const items = object[key];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !accepts(item)))
      throw new Error(`agent ${key} contains an invalid value`);
    if (new Set(items).size !== items.length) throw new Error(`agent ${key} contains duplicate values`);
    return [...items];
  };
  return {
    schemaVersion: 1,
    name: object.name,
    description: object.description,
    instructions: object.instructions,
    model: object.model,
    tools: list("tools", (item) => (AGENT_TOOLS as readonly string[]).includes(item)) as AgentTool[],
    delegatesTo: list("delegatesTo", (item) => name.test(item)),
    credentials: list("credentials", (item) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(item)),
    ...(limits ? { limits } : {}),
  };
}

export function agentManifestDigest(manifest: AgentManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

/** Count bytes before decoding so fragmented UTF-8 and trailing partial records share one limit. */
export class WorkerRecordDecoder {
  private readonly decoder = new JsonLineDecoder();
  private bytes = 0;

  constructor(private readonly limit = MAX_RECORD_BYTES) {}

  push(chunk: Buffer): string[] {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      this.bytes += (newline === -1 ? chunk.length : newline) - start;
      if (this.bytes > this.limit) throw new Error("worker record exceeds the connection limit");
      if (newline === -1) break;
      this.bytes = 0;
      start = newline + 1;
    }
    return this.decoder.push(chunk);
  }
}

export interface WorkerIdentity {
  /** A host projection of saved conversation state, with no live execution lease. */
  archived?: boolean;
  version: typeof WORKER_PROTOCOL_VERSION;
  incarnation: string;
  pid: number;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  roleDigest?: string;
  /** A role using the configured default still pins the model resolved for this attempt. */
  model?: string;
  assignment?: WorkerAssignment;
}

export interface WorkerHello {
  type: "hello";
  version: number;
  control: boolean;
  supervisor?: boolean;
}

export type WorkerCommand =
  | RpcCommand
  | { type: "shutdown" }
  | { type: "get_snapshot" }
  | { type: "get_delivery"; batchId: string }
  | { type: "initialize"; manifest: AgentManifest; assignment?: WorkerAssignment }
  | InboxDelivery;

export type ClientRecord =
  | WorkerHello
  | { type: "command"; id: string; command: WorkerCommand }
  | { type: "answer"; response: RpcExtensionUIResponse }
  | DomainResult
  | { type: "credentials"; id: string; apiKeys: Record<string, string> };

export type ServerRecord =
  | DomainRequest
  | {
      type: "welcome";
      worker: WorkerIdentity;
      control: boolean;
      sequence: number;
      uiRequests: RpcExtensionUIRequest[];
      capabilities: string[];
    }
  | { type: "rejected"; error: string }
  | { type: "result"; id: string; success: true; data?: unknown }
  | { type: "result"; id: string; success: false; error: string }
  | { type: "event"; sequence: number; event: PiEvent }
  | { type: "ui"; sequence: number; request: RpcExtensionUIRequest }
  | { type: "ui_closed"; sequence: number; id: string };

const READ_COMMANDS = new Set<WorkerCommand["type"]>([
  "get_state",
  "get_snapshot",
  "get_delivery",
  "get_messages",
  "get_session_stats",
  "get_available_models",
  "get_available_thinking_levels",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "get_commands",
]);

export function isReadCommand(command: WorkerCommand): boolean {
  return READ_COMMANDS.has(command.type);
}

/** Stable IDs identify payloads, independently of JSON property ordering. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface WorkerEngine {
  call(command: RpcCommand): Promise<unknown>;
  snapshot?(): Omit<AgentSnapshot, "sequence">;
  respond(response: RpcExtensionUIResponse): void;
  close(): Promise<void>;
  deliver?(delivery: InboxDelivery): Promise<{ entryId: string; duplicate: boolean }>;
  deliveryStatus?(batchId: string): { entryId: string | null; payloadHash?: string };
  provision?(apiKeys: Readonly<Record<string, string>>): Promise<void>;
}

export interface WorkerEngineContext {
  cwd: string;
  stateDirectory: string;
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  instructions?: string;
  role?: AgentManifest;
  assignment?: WorkerAssignment;
  apiKeys?: Readonly<Record<string, string>>;
  domain?(
    assistantEntryId: string,
    toolCallId: string,
    command: DomainCommand,
    signal?: AbortSignal,
  ): Promise<unknown>;
  recoverDomain?(
    assistantEntryId: string,
    toolCallId: string,
    command: DomainCommand,
  ): Promise<DomainResult | null>;
  configDirectory?: string;
  authFile?: string;
  onEvent(event: PiEvent): void;
  onUiRequest(request: RpcExtensionUIRequest): void;
  onUiClose(id: string): void;
}
