import { randomUUID } from "node:crypto";
import { type ClientRequest, request } from "node:http";
import {
  type CommandResult,
  type ConversationLink,
  JsonLineDecoder,
  type SessionCommand,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
  type SessionStats,
  scrub,
} from "@pituitary/session";

export interface ConversationIdentity {
  runId: string;
  taskId: string;
  attemptId: string;
  cwd: string;
  local: boolean;
  archived: boolean;
  role?: string;
}
export type ConversationCommand = SessionCommand | { type: "get_snapshot"; id?: string };
export type ConversationUpdate =
  | { type: "event"; sequence: number; event: SessionEvent }
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "closed"; reason: string };
export type ConversationRecord =
  | ConversationUpdate
  | {
      type: "welcome";
      id: string;
      identity: ConversationIdentity;
      control: boolean;
      capabilities: string[];
      snapshot: SessionSnapshot;
    };
export interface ConnectConversationOptions {
  socketPath: string;
  runId: string;
  taskId: string;
  control: boolean;
  timeout?: number;
  signal?: AbortSignal;
}

/** A disposable view of a host-owned conversation. Closing it never stops the run. */
export class ConversationClient implements ConversationLink {
  private readonly events = new Set<(event: SessionEvent, sequence: number) => void>();
  private readonly closes = new Set<(reason: string) => void>();
  private readonly buffered: Array<{ event: SessionEvent; sequence: number }> = [];
  private readonly requests = new Set<ClientRequest>();
  private attachment = "";
  private reason: string | null = null;
  private currentSnapshot?: SessionSnapshot;
  private currentIdentity!: ConversationIdentity;
  private input = false;
  private offered: readonly string[] = [];
  private stream?: ClientRequest;
  private readonly ready: Promise<void>;
  private rejectReady: (error: Error) => void = () => {};
  private attachmentTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ConnectConversationOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      const decoder = new JsonLineDecoder();
      let bytes = 0;
      this.attachmentTimer = setTimeout(
        () => this.fail("Conversation attachment timed out"),
        options.timeout ?? 15000,
      );
      const fail = (reason: string) => this.fail(reason);
      const stream = request(
        {
          socketPath: options.socketPath,
          method: "GET",
          agent: false,
          path: `/v1/runs/${encodeURIComponent(options.runId)}/conversations/${encodeURIComponent(options.taskId)}?control=${options.control ? "1" : "0"}`,
        },
        (response) => {
          if (response.statusCode !== 200) {
            let body = "";
            response.on("data", (chunk) => {
              if (body.length < 65536) body += String(chunk);
            });
            response.once("end", () => {
              let reason = body;
              try {
                reason = JSON.parse(body).error ?? body;
              } catch {}
              fail(scrub(String(reason || `Attachment refused (${response.statusCode})`)));
            });
            return;
          }
          response.on("data", (chunk: Buffer) => {
            try {
              for (const byte of chunk) {
                bytes = byte === 10 ? 0 : bytes + 1;
                if (bytes > 16 * 1024 * 1024) throw new Error("Conversation record exceeds its byte limit");
              }
              for (const line of decoder.push(chunk)) {
                const record = scrub(JSON.parse(line)) as ConversationRecord;
                if (!record || typeof record !== "object") throw new Error("Invalid conversation record");
                if (record.type === "welcome") {
                  if (
                    this.attachment ||
                    !record.id ||
                    !record.identity ||
                    typeof record.control !== "boolean" ||
                    !Array.isArray(record.capabilities) ||
                    !record.snapshot
                  )
                    throw new Error("Invalid conversation welcome");
                  this.attachment = record.id;
                  this.currentIdentity = record.identity;
                  this.input = record.control;
                  this.offered = record.capabilities;
                  this.currentSnapshot = record.snapshot;
                  clearTimeout(this.attachmentTimer);
                  options.signal?.removeEventListener("abort", abort);
                  resolve();
                } else if (!this.attachment) throw new Error("Conversation welcome is missing");
                else if (record.type === "event") this.publish(record.event, record.sequence);
                else if (record.type === "snapshot") {
                  this.currentSnapshot = record.snapshot;
                  this.publish({ type: "session_info_changed" } as SessionEvent, record.snapshot.sequence);
                } else if (record.type === "closed") fail(record.reason);
                else throw new Error("Unknown conversation record");
              }
            } catch (error) {
              fail(String(error));
              stream.destroy();
            }
          });
          response.once("error", (error) => fail(`Conversation stream failed: ${error.message}`));
          response.once("end", () => fail("Conversation detached"));
        },
      );
      this.stream = stream;
      const abort = () => fail("Conversation attachment cancelled");
      options.signal?.addEventListener("abort", abort, { once: true });
      stream.once("close", () => options.signal?.removeEventListener("abort", abort));
      if (options.signal?.aborted) abort();
      stream.once("error", (error) => fail(`Conversation connection failed: ${error.message}`));
      stream.end();
    });
    void this.ready.catch(() => {});
  }
  async connected(): Promise<this> {
    await this.ready;
    return this;
  }
  get identity(): ConversationIdentity {
    return this.currentIdentity;
  }
  get controlsInput(): boolean {
    return this.input;
  }
  get capabilities(): readonly string[] {
    return this.offered;
  }
  private publish(event: SessionEvent, sequence: number) {
    if (!this.events.size) {
      if (this.buffered.length >= 2048) {
        this.fail("Conversation observer fell behind; reconnect to refresh");
        return;
      }
      this.buffered.push({ event, sequence });
    } else for (const listener of this.events) listener(event, sequence);
  }
  private fail(reason: string) {
    if (this.reason !== null) return;
    this.reason = reason;
    this.input = false;
    clearTimeout(this.attachmentTimer);
    this.rejectReady(new Error(reason));
    this.stream?.destroy();
    for (const pending of this.requests) pending.destroy(new Error(reason));
    for (const listener of this.closes) listener(reason);
  }
  onEvent(listener: (event: SessionEvent, sequence: number) => void): () => void {
    this.events.add(listener);
    for (const { event, sequence } of this.buffered.splice(0)) listener(event, sequence);
    return () => {
      this.events.delete(listener);
    };
  }
  onClose(listener: (reason: string) => void): () => void {
    this.closes.add(listener);
    if (this.reason !== null) listener(this.reason);
    return () => {
      this.closes.delete(listener);
    };
  }
  async getSnapshot(): Promise<SessionSnapshot> {
    if (this.currentSnapshot) {
      const snapshot = this.currentSnapshot;
      this.currentSnapshot = undefined;
      return snapshot;
    }
    return this.send({ type: "get_snapshot" }) as Promise<SessionSnapshot>;
  }
  private async send(command: ConversationCommand): Promise<unknown> {
    await this.ready;
    if (this.reason !== null) throw new Error(this.reason);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.options.socketPath,
          method: "POST",
          agent: false,
          path: `/v1/conversations/${encodeURIComponent(this.attachment)}/commands`,
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024)
              response.destroy(new Error("Conversation response exceeds its byte limit"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const data = scrub(JSON.parse(Buffer.concat(chunks).toString()));
              if ((response.statusCode ?? 500) >= 300)
                reject(new Error(data.error ?? "Conversation command failed"));
              else resolve(data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      this.requests.add(req);
      req.once("close", () => this.requests.delete(req));
      req.once("error", reject);
      req.setTimeout(this.options.timeout ?? 15000, () =>
        req.destroy(new Error("Conversation response timed out; its input may have been admitted")),
      );
      req.end(JSON.stringify({ id: ("id" in command ? command.id : undefined) ?? randomUUID(), command }));
    });
  }
  call<C extends SessionCommand>(command: C): Promise<CommandResult<C["type"]>> {
    return this.send(command) as Promise<CommandResult<C["type"]>>;
  }
  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.call({ type: "prompt", message, streamingBehavior });
  }
  async abort(): Promise<void> {
    await this.call({ type: "abort" });
  }
  getState(): Promise<SessionState> {
    return this.call({ type: "get_state" });
  }
  async getMessages(): Promise<unknown[]> {
    return (await this.call({ type: "get_messages" })).messages;
  }
  getSessionStats(): Promise<SessionStats> {
    return this.call({ type: "get_session_stats" });
  }
  async abortRetry(): Promise<void> {
    await this.call({ type: "abort_retry" });
  }
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.call({ type: "clear_queue" });
  }
  async close(): Promise<void> {
    this.fail("Conversation detached");
  }
}
export async function connectConversation(options: ConnectConversationOptions): Promise<ConversationClient> {
  return new ConversationClient(options).connected();
}
