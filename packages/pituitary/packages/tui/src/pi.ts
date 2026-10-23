import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  type CommandResult,
  type ConversationLink,
  encodeJsonLine,
  JsonLineDecoder,
  type SessionCommand,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
  type SessionStats,
  scrub,
} from "@pituitary/session";

export type PiUiRequest = { type: "extension_ui_request"; id: string } & (
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; title: string; message: string; timeout?: number }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string }
  | { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { method: "setStatus"; statusKey: string; statusText?: string }
  | { method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
);
export type PiUiResponse = { type: "extension_ui_response"; id: string } & (
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
);
export interface PiUiPort {
  onRequest(listener: (request: PiUiRequest) => void): () => void;
  respond(response: PiUiResponse): void;
}
export interface PiOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStderr?(text: string): void;
}

type Pending = { resolve(data: unknown): void; reject(error: Error): void };
type PiCommand = { type: string; [key: string]: unknown };
type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
const EVENTS = new Set([
  "message_start", "message_end", "message_update", "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end", "session_info_changed", "tool_execution_start", "tool_execution_update",
  "tool_execution_end", "queue_update", "compaction_start", "compaction_end", "auto_retry_start",
  "auto_retry_end", "runtime_error",
]);

/** Pi owns the session. This adapter owns its process and translates only presentation. */
export class PiConversation implements ConversationLink, PiUiPort {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new JsonLineDecoder();
  private readonly listeners = new Set<(event: SessionEvent, sequence: number) => void>();
  private readonly uiListeners = new Set<(request: PiUiRequest) => void>();
  private readonly waitingUi: PiUiRequest[] = [];
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly tools = new Map<string, { callId: string; name: string; output?: string; details?: unknown }>();
  private nextId = 0;
  private sequence = 0;
  private closed?: string;
  private closing?: Promise<void>;
  private streaming?: { role: "assistant"; content: Block[] };
  private running?: boolean;
  private compacting?: boolean;
  private retry?: SessionSnapshot["retry"];
  private queue?: SessionSnapshot["queue"];
  sessionFile?: string;

  constructor(private readonly options: PiOptions) {
    this.child = spawn(options.command, [...(options.args ?? []), "--mode", "rpc"], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const record of this.decoder.push(chunk)) this.receive(record);
    });
    this.child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString()));
    this.child.stdin.on("error", (error) => this.fail(`Pi input closed: ${error.message}`));
    this.child.once("error", (error) => this.fail(`Could not start ${options.command}: ${error.message}`));
    this.child.once("close", (code, signal) => {
      for (const record of this.decoder.flush()) this.receive(record);
      this.fail(`Pi exited (${signal ?? code ?? "unknown"})`);
    });
  }

  onEvent(listener: (event: SessionEvent, sequence: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onRequest(listener: (request: PiUiRequest) => void): () => void {
    this.uiListeners.add(listener);
    for (const request of this.waitingUi.splice(0)) listener(request);
    return () => this.uiListeners.delete(listener);
  }
  onClose(listener: (reason: string) => void): () => void {
    if (this.closed) listener(this.closed);
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  respond(response: PiUiResponse): void {
    if (!this.closed) this.child.stdin.write(encodeJsonLine(response));
  }
  request(command: PiCommand): Promise<unknown> {
    return this.send(command);
  }
  async call<C extends SessionCommand>(command: C): Promise<CommandResult<C["type"]>> {
    return await this.send(command) as CommandResult<C["type"]>;
  }
  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.send({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }
  async abort(): Promise<void> { await this.send({ type: "abort" }); }
  async abortRetry(): Promise<void> { await this.send({ type: "abort_retry" }); }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return await this.send({ type: "clear_queue" }) as { steering: string[]; followUp: string[] };
  }
  async getState(): Promise<SessionState> {
    return this.send({ type: "get_state" }, (data) => {
      const state = data as SessionState;
      this.sessionFile = state.sessionFile;
      return state;
    });
  }
  async getMessages(): Promise<unknown[]> {
    return (await this.send({ type: "get_messages" }) as { messages: unknown[] }).messages;
  }
  async getSessionStats(): Promise<SessionStats> {
    return await this.send({ type: "get_session_stats" }) as SessionStats;
  }
  async getSnapshot(): Promise<SessionSnapshot> {
    const state = await this.getState();
    // Capture the live projection at the response's position in the same JSONL stream.
    // Later records can share its chunk; a Promise continuation would observe them too late.
    return this.send({ type: "get_messages" }, (data) => ({
      sequence: this.sequence,
      state: {
        ...state,
        isStreaming: this.running ?? state.isStreaming,
        isCompacting: this.compacting ?? state.isCompacting,
        messageCount: (data as { messages: unknown[] }).messages.length,
        pendingMessageCount: this.queue ? this.queue.steering.length + this.queue.followUp.length : state.pendingMessageCount,
      },
      messages: (data as { messages: unknown[] }).messages,
      streamingMessage: this.streaming ? structuredClone(this.streaming) : undefined,
      pendingToolCalls: [...this.tools.keys()],
      pendingTools: [...this.tools.values()],
      retry: this.retry,
      queue: this.queue,
    }));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); }, 2000);
      this.child.once("close", () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    });
    return this.closing;
  }

  private send<T = unknown>(command: PiCommand, read: (data: unknown) => T = (data) => data as T): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = `pituitary-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (data) => {
        try { resolve(read(data)); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      }, reject });
      this.child.stdin.write(encodeJsonLine({ ...command, id }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  private receive(record: string): void {
    let output: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(record);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a record");
      output = scrub(parsed) as Record<string, unknown>;
    }
    catch { this.options.onStderr?.(`Invalid Pi JSON record: ${record}\n`); return; }
    if (output.type === "response") {
      const id = String(output.id), pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (output.success) pending.resolve(output.data);
      else pending.reject(new Error(String(output.error)));
      return;
    }
    if (output.type === "extension_ui_request") {
      const request = output as unknown as PiUiRequest;
      if (!this.uiListeners.size) this.waitingUi.push(request);
      else for (const listener of this.uiListeners) listener(request);
      return;
    }
    if (!EVENTS.has(String(output.type))) return;
    const event = output as unknown as SessionEvent;
    this.project(event);
    const sequence = ++this.sequence;
    for (const listener of this.listeners) listener(event, sequence);
  }
  private project(event: SessionEvent): void {
    switch (event.type) {
      case "agent_start": this.running = true; break;
      case "agent_settled": this.running = false; this.streaming = undefined; break;
      case "compaction_start": this.compacting = true; break;
      case "compaction_end": this.compacting = false; break;
      case "queue_update": this.queue = { steering: event.steering, followUp: event.followUp }; break;
      case "auto_retry_start":
        this.retry = { attempt: event.attempt, maxAttempts: event.maxAttempts, at: Date.now() + event.delayMs, errorMessage: event.errorMessage };
        break;
      case "auto_retry_end": this.retry = undefined; break;
      case "message_start": {
        const message = event.message as { role?: string; content?: Block[] };
        if (message.role === "assistant") this.streaming = { role: "assistant", content: structuredClone(message.content ?? []) };
        break;
      }
      case "message_end":
        if ((event.message as { role?: string }).role === "assistant") this.streaming = undefined;
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (!this.streaming) break;
        const content = this.streaming.content, index = delta.contentIndex;
        switch (delta.type) {
          case "text_start": content[index] = { type: "text", text: "" }; break;
          case "thinking_start": content[index] = { type: "thinking", thinking: "" }; break;
          case "text_delta": {
            const block = content[index] ?? { type: "text", text: "" };
            block.text = (block.text ?? "") + delta.delta; content[index] = block; break;
          }
          case "thinking_delta": {
            const block = content[index] ?? { type: "thinking", thinking: "" };
            block.thinking = (block.thinking ?? "") + delta.delta; content[index] = block; break;
          }
          case "text_end": content[index] = { type: "text", text: delta.content }; break;
          case "thinking_end": content[index] = { type: "thinking", thinking: delta.content }; break;
          case "toolcall_start": content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} }; break;
          case "toolcall_end": content[index] = delta.toolCall; break;
        }
        break;
      }
      case "tool_execution_start": this.tools.set(event.toolCallId, { callId: event.toolCallId, name: event.toolName }); break;
      case "tool_execution_update": {
        const content = event.partialResult.content;
        const output = Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n") : String(content ?? "");
        this.tools.set(event.toolCallId, { callId: event.toolCallId, name: event.toolName, output, details: event.partialResult.details });
        break;
      }
      case "tool_execution_end": this.tools.delete(event.toolCallId); break;
    }
  }
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
  }
}
