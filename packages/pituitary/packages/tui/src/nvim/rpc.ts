import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { decodeMultiStream, Encoder, ExtensionCodec } from "@msgpack/msgpack";

/**
 * A msgpack-RPC session with an embedded nvim over its stdio.
 * https://neovim.io/doc/user/api.html#rpc
 */
export class NvimRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly encoder: Encoder;
  private readonly codec = new ExtensionCodec();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(cause: Error): void }>();
  private readonly listeners = new Set<(method: string, params: unknown[]) => void>();
  private readonly closers = new Set<(reason: string) => void>();
  private next = 1;
  private closed: string | null = null;

  constructor(command: string, args: readonly string[]) {
    // Buffer, Window, and Tabpage handles arrive as ext types 0..2; only their ids matter here.
    for (const type of [0, 1, 2]) {
      this.codec.register({ type, encode: () => null, decode: (data) => data });
    }
    this.encoder = new Encoder({ extensionCodec: this.codec });
    // A session of its own keeps nvim off the terminal, where `ps -t <tty>` checks for a running
    // vim, such as tmux's pane navigation, would take the UI for one.
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    this.child.stderr.resume();
    this.child.on("error", (cause) => this.fail(cause.message));
    this.child.on("exit", (code, signal) => this.fail(`nvim exited (${signal ?? code})`));
    this.child.stdin.on("error", (cause) => this.fail(cause.message));
    void this.read();
  }

  /** Calls an API function and resolves with its result. */
  request(method: string, params: unknown[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write([0, id, method, params]);
    });
  }

  /** Calls an API function without waiting for its result. */
  notify(method: string, params: unknown[] = []): void {
    if (!this.closed) this.write([2, method, params]);
  }

  onNotification(listener: (method: string, params: unknown[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` once the session ends, at once when it already has. */
  onClose(listener: (reason: string) => void): () => void {
    const reason = this.closed;
    if (reason) queueMicrotask(() => listener(reason));
    this.closers.add(listener);
    return () => this.closers.delete(listener);
  }

  close(): void {
    this.fail("closed");
    this.child.kill();
  }

  private write(message: unknown[]): void {
    this.child.stdin.write(this.encoder.encode(message));
  }

  private async read(): Promise<void> {
    try {
      for await (const message of decodeMultiStream(this.child.stdout, { extensionCodec: this.codec })) {
        this.dispatch(message as unknown[]);
      }
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : String(cause));
    }
  }

  private dispatch(message: unknown[]): void {
    const [kind] = message;
    if (kind === 1) {
      const [, id, error, result] = message as [1, number, unknown, unknown];
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (error) waiter.reject(new Error(describe(error)));
      else waiter.resolve(result);
    } else if (kind === 2) {
      const [, method, params] = message as [2, string, unknown[]];
      for (const listener of this.listeners) listener(method, params);
    } else if (kind === 0) {
      // nvim asks nothing of this client; an answer keeps a stray rpcrequest from hanging it.
      const [, id] = message as [0, number];
      this.write([1, id, "no methods", null]);
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    for (const listener of this.closers) listener(reason);
  }
}

function describe(error: unknown): string {
  if (Array.isArray(error)) return String(error[1] ?? error[0]);
  return String(error);
}
