import {
  type AgentSnapshot,
  JsonLineDecoder,
  type PiEvent,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "@pituitary/rpc";

export const WORKER_PROTOCOL_VERSION = 1;
/** A bounded live connection is disposable; the worker and its transcript are not. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_CLIENT_BACKLOG_BYTES = 2 * 1024 * 1024;

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
  version: typeof WORKER_PROTOCOL_VERSION;
  incarnation: string;
  pid: number;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
}

export interface WorkerHello {
  type: "hello";
  version: number;
  control: boolean;
}

export type WorkerCommand = RpcCommand | { type: "shutdown" } | { type: "get_snapshot" };

export type ClientRecord =
  | WorkerHello
  | { type: "command"; id: string; command: WorkerCommand }
  | { type: "answer"; response: RpcExtensionUIResponse };

export type ServerRecord =
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
}

export interface WorkerEngineContext {
  cwd: string;
  stateDirectory: string;
  sessionFile?: string;
  sessionId?: string;
  model?: string;
  instructions?: string;
  configDirectory?: string;
  authFile?: string;
  onEvent(event: PiEvent): void;
  onUiRequest(request: RpcExtensionUIRequest): void;
  onUiClose(id: string): void;
}
