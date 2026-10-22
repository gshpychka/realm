import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  type AgentLink,
  type AgentSnapshot,
  type BashResult,
  encodeJsonLine,
  type PiEvent,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type RpcSessionState,
  type SessionStats,
  scrub,
} from "@pituitary/rpc";
import {
  type ServerRecord,
  WORKER_PROTOCOL_VERSION,
  type WorkerCommand,
  type WorkerIdentity,
  WorkerRecordDecoder,
} from "./protocol.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class WorkerClient implements AgentLink {
  private readonly events = new Set<(event: PiEvent, sequence?: number) => void>();
  private readonly ui = new Set<(request: RpcExtensionUIRequest) => void>();
  private readonly uiCloses = new Set<(id: string) => void>();
  private readonly closes = new Set<(reason: string) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly beforeSubscribe: Array<{ event: PiEvent; sequence: number }> = [];
  private initialUi: RpcExtensionUIRequest[] = [];
  private reason: string | null = null;
  private worker: WorkerIdentity | null = null;
  private readonly ready: Promise<void>;
  getSnapshot?: () => Promise<AgentSnapshot>;

  constructor(
    private readonly socket: Socket,
    control: boolean,
    timeout = 10_000,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      const decoder = new WorkerRecordDecoder();
      const timer = setTimeout(() => {
        reject(new Error("worker handshake timed out"));
        socket.destroy();
      }, timeout);
      const fail = (reason: string) => {
        clearTimeout(timer);
        reject(new Error(reason));
        this.fail(reason);
      };
      socket.on("data", (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (cause) {
          fail(cause instanceof Error ? cause.message : String(cause));
          socket.destroy();
          return;
        }
        for (const line of lines) {
          let record: ServerRecord;
          try {
            record = scrub(JSON.parse(line) as ServerRecord);
            if (
              !record ||
              typeof record !== "object" ||
              !["welcome", "rejected", "event", "ui", "ui_closed", "result"].includes(record.type)
            )
              throw new Error("invalid record type");
            if (
              record.type === "welcome" &&
              (!record.worker || !Array.isArray(record.uiRequests) || !Array.isArray(record.capabilities))
            )
              throw new Error("invalid worker identity");
            if (record.type === "event" && (!record.event || typeof record.event.type !== "string"))
              throw new Error("invalid worker event");
            if (record.type === "ui" && (!record.request || typeof record.request.id !== "string"))
              throw new Error("invalid worker UI request");
            if (
              record.type === "result" &&
              (typeof record.id !== "string" || typeof record.success !== "boolean")
            )
              throw new Error("invalid worker result");
          } catch {
            fail("worker sent an invalid protocol record");
            socket.destroy();
            return;
          }
          if (record.type === "welcome") {
            if (record.worker.version !== WORKER_PROTOCOL_VERSION) {
              fail(`unsupported worker protocol ${record.worker.version}`);
              socket.destroy();
              return;
            }
            this.worker = record.worker;
            this.initialUi = record.uiRequests;
            if (record.capabilities.includes("atomic-snapshot")) {
              this.getSnapshot = async () => (await this.request({ type: "get_snapshot" })) as AgentSnapshot;
            }
            clearTimeout(timer);
            resolve();
          } else if (record.type === "rejected") {
            fail(record.error);
            socket.destroy();
          } else if (record.type === "event") {
            if (!this.events.size) {
              this.beforeSubscribe.push({ event: record.event, sequence: record.sequence });
              if (this.beforeSubscribe.length > 512) this.beforeSubscribe.shift();
            }
            for (const listener of this.events) listener(record.event, record.sequence);
          } else if (record.type === "ui") {
            if (!this.ui.size) this.initialUi.push(record.request);
            for (const listener of this.ui) listener(record.request);
          } else if (record.type === "ui_closed") {
            this.initialUi = this.initialUi.filter((request) => request.id !== record.id);
            for (const listener of this.uiCloses) listener(record.id);
          } else if (record.type === "result") {
            const pending = this.pending.get(record.id);
            if (!pending) continue;
            this.pending.delete(record.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (record.success) pending.resolve(record.data);
            else pending.reject(new Error(record.error));
          }
        }
      });
      socket.on("error", (error) => fail(`worker connection failed: ${error.message}`));
      socket.on("close", () => fail("worker connection closed"));
      socket.once("connect", () => {
        socket.write(encodeJsonLine({ type: "hello", version: WORKER_PROTOCOL_VERSION, control }));
      });
    });
  }

  async connected(): Promise<this> {
    await this.ready;
    return this;
  }

  get identity(): WorkerIdentity {
    if (!this.worker) throw new Error("worker is not connected");
    return this.worker;
  }

  onEvent(listener: (event: PiEvent, sequence?: number) => void): () => void {
    this.events.add(listener);
    for (const { event, sequence } of this.beforeSubscribe.splice(0)) listener(event, sequence);
    return () => this.events.delete(listener);
  }

  onUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
    this.ui.add(listener);
    for (const request of this.initialUi.splice(0)) listener(request);
    return () => this.ui.delete(listener);
  }

  onUiClose(listener: (id: string) => void): () => void {
    this.uiCloses.add(listener);
    return () => this.uiCloses.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.reason) listener(this.reason);
    else this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  respond(response: RpcExtensionUIResponse): void {
    if (!this.reason) this.socket.write(encodeJsonLine({ type: "answer", response }));
  }

  async request(command: WorkerCommand, id: string = randomUUID(), timeout = 0): Promise<unknown> {
    await this.ready;
    if (this.reason) throw new Error(this.reason);
    if (this.pending.has(id)) throw new Error(`command ${id} is already pending on this connection`);
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (timeout > 0)
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`worker command ${command.type} timed out; its outcome may still be pending`));
        }, timeout);
      this.pending.set(id, pending);
      this.socket.write(encodeJsonLine({ type: "command", id, command }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async call<C extends RpcCommand>(command: C): Promise<import("@pituitary/rpc").ResponseData<C["type"]>> {
    return (await this.request(command, command.id)) as import("@pituitary/rpc").ResponseData<C["type"]>;
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.call({ type: "prompt", message, streamingBehavior });
  }

  async abort(): Promise<void> {
    await this.call({ type: "abort" });
  }

  getState(): Promise<RpcSessionState> {
    return this.call({ type: "get_state" });
  }

  async getMessages(): Promise<unknown[]> {
    return (await this.call({ type: "get_messages" })).messages;
  }

  getSessionStats(): Promise<SessionStats> {
    return this.call({ type: "get_session_stats" });
  }

  async bash(request: string, command: string, excluded: boolean): Promise<BashResult> {
    return (await this.request({
      type: "bash",
      id: request,
      command,
      excludeFromContext: excluded,
    })) as BashResult;
  }

  async abortBash(): Promise<void> {
    await this.call({ type: "abort_bash" });
  }

  async abortRetry(): Promise<void> {
    await this.call({ type: "abort_retry" });
  }

  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.call({ type: "clear_queue" });
  }

  async shutdown(): Promise<void> {
    await this.request({ type: "shutdown" });
  }

  /** Detaching never aborts the worker or closes its native session. */
  async close(): Promise<void> {
    this.fail("worker client detached");
    this.socket.destroy();
  }

  private fail(reason: string): void {
    if (this.reason) return;
    this.reason = reason;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    for (const listener of this.closes) listener(reason);
    this.closes.clear();
  }
}

export async function connectWorker(
  socketPath: string,
  options: { control?: boolean; timeout?: number } = {},
): Promise<WorkerClient> {
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
    throw new Error("worker connection timeout must be positive");
  return new WorkerClient(connect(socketPath), options.control !== false, options.timeout).connected();
}
