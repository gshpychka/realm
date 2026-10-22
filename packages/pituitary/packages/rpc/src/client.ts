import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { encodeJsonLine, JsonLineDecoder } from "./jsonl.ts";
import {
  isRpcResponse,
  type PiEvent,
  type PiOutput,
  type ResponseData,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type RpcSessionState,
  type SessionStats,
  scrub,
} from "./protocol.ts";
import type { BashResult } from "./session.ts";

/**
 * The agent contract the UI renders against.
 *
 * Commands resolve once pi accepts them; everything the UI displays arrives through `onEvent`.
 */
export interface AgentLink {
  onEvent(listener: (event: PiEvent) => void): () => void;
  /** Requests extensions make of the operator: dialogs to answer, and text to show. */
  onUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void;
  /** Called once, with the reason, when the agent can no longer be reached. */
  onClose(listener: (reason: string) => void): () => void;
  /** Answers a dialog. pi sends nothing back. */
  respond(response: RpcExtensionUIResponse): void;
  /** Sends any RPC command and resolves with what pi answers it with. */
  call<C extends RpcCommand>(command: C): Promise<ResponseData<C["type"]>>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<RpcSessionState>;
  /**
   * Runs a shell command for the operator. Its output streams as `bash_execution_update`
   * events carrying `request`, and the result arrives once it exits.
   */
  bash(request: string, command: string, excluded: boolean): Promise<BashResult>;
  abortBash(): Promise<void>;
  /** Stops the automatic retry pi is waiting to make. */
  abortRetry(): Promise<void>;
  /** Takes every queued steering and follow-up message back out of pi's queue. */
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  /** The messages of the session as pi holds it now. */
  getMessages(): Promise<unknown[]>;
  /** Tokens, cost, and context use across the session. */
  getSessionStats(): Promise<SessionStats>;
  close(): Promise<void>;
}

export interface PiRpcClientOptions {
  /** Executable that speaks the RPC protocol on stdin/stdout. */
  command: string;
  /** Arguments before `--mode rpc`. */
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Sink for the agent's stderr. Writing it to the terminal corrupts the rendered UI. */
  onStderr?: (chunk: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class PiRpcClient implements AgentLink {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new JsonLineDecoder();
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly uiListeners = new Set<(request: RpcExtensionUIRequest) => void>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private exitReason: string | null = null;

  constructor(private readonly options: PiRpcClientOptions) {}

  start(): void {
    if (this.child) throw new Error("client already started");
    const args = [...(this.options.args ?? []), "--mode", "rpc"];
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      for (const record of this.decoder.push(chunk)) this.handleRecord(record);
    });
    child.stderr.on("data", (chunk: Buffer) => this.options.onStderr?.(chunk.toString()));
    child.on("error", (error) => this.fail(`agent process failed to start: ${error.message}`));
    child.on("exit", (code, signal) => {
      for (const record of this.decoder.flush()) this.handleRecord(record);
      this.fail(`agent process exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      this.options.onExit?.(code, signal);
    });
  }

  onEvent(listener: (event: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.exitReason !== null) listener(this.exitReason);
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  respond(response: RpcExtensionUIResponse): void {
    this.child?.stdin.write(encodeJsonLine(response));
  }

  async call<C extends RpcCommand>(command: C): Promise<ResponseData<C["type"]>> {
    return (await this.request(command)) as ResponseData<C["type"]>;
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.request({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" });
  }

  async getState(): Promise<RpcSessionState> {
    return (await this.request({ type: "get_state" }, 10_000)) as RpcSessionState;
  }

  async getSessionStats(): Promise<SessionStats> {
    return (await this.request({ type: "get_session_stats" }, 10_000)) as SessionStats;
  }

  async getMessages(): Promise<unknown[]> {
    const data = (await this.request({ type: "get_messages" }, 10_000)) as
      | { messages?: unknown[] }
      | undefined;
    return data?.messages ?? [];
  }

  async bash(request: string, command: string, excluded: boolean): Promise<BashResult> {
    return (await this.request(
      { type: "bash", command, excludeFromContext: excluded },
      0,
      request,
    )) as BashResult;
  }

  async abortBash(): Promise<void> {
    await this.request({ type: "abort_bash" });
  }

  async abortRetry(): Promise<void> {
    await this.request({ type: "abort_retry" });
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const data = (await this.request({ type: "clear_queue" })) as {
      steering?: string[];
      followUp?: string[];
    };
    return { steering: data?.steering ?? [], followUp: data?.followUp ?? [] };
  }

  /** Resolves with pi's `data` payload, or rejects with the error it reported. */
  request(command: RpcCommand, timeoutMs = 0, id = `req-${++this.nextId}`): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(this.exitReason ?? "client not started"));
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${command.type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      child.stdin.write(encodeJsonLine({ ...command, id }), (error) => {
        if (!error) return;
        this.settle(id, () => reject(new Error(`write failed: ${error.message}`)));
      });
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(kill);
        resolve();
        return;
      }
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private handleRecord(record: string): void {
    let output: PiOutput;
    try {
      // Nothing pi relays reaches the terminal with its control characters.
      output = scrub(JSON.parse(record) as PiOutput);
    } catch {
      this.options.onStderr?.(`unparseable record: ${record}\n`);
      return;
    }
    if (isRpcResponse(output)) {
      const id = output.id;
      if (id === undefined) return;
      this.settle(id, (pending) => {
        if (output.success) pending.resolve("data" in output ? output.data : undefined);
        else pending.reject(new Error(output.error));
      });
      return;
    }
    if (output.type === "extension_ui_request") {
      for (const listener of this.uiListeners) listener(output);
      return;
    }
    for (const listener of this.listeners) listener(output as PiEvent);
  }

  private settle(id: string, apply: (pending: Pending) => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    apply(pending);
  }

  private fail(reason: string): void {
    if (this.exitReason === null) {
      for (const listener of this.closeListeners) listener(reason);
      this.closeListeners.clear();
    }
    this.exitReason = reason;
    for (const [id] of this.pending) this.settle(id, (pending) => pending.reject(new Error(reason)));
  }
}
