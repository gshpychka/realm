import { once } from "node:events";
import { posix } from "node:path";
import type { Duplex } from "node:stream";
import { type Context, withoutAbortSignal } from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  LineScanner,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { Bay } from "./bay.ts";
import type { BayExecution } from "./model.ts";

type Frame = {
  id: number;
  value?: unknown;
  error?: { code: string; message: string };
  stream?: "stdout" | "stderr";
  data?: string;
};
type Pending = {
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  output?: (frame: Frame) => void;
};
const CHUNK = 64 * 1024;
const success = <T>(value: T): Result<T, FileError> => ({ ok: true, value });
const failed = <T>(error: FileError): Result<T, FileError> => ({ ok: false, error });

/** A conversation's machine is a filesystem and process environment; all models,
 * task recovery, and persistence belong to the host Durable Harness. */
export class BayExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private link: Promise<Duplex> | undefined;
  private connectionAbort = new AbortController();
  private stream: Duplex | undefined;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private writeQueue = Promise.resolve();
  private closed: Error | undefined;
  private closing: Promise<void> | undefined;
  private disposing = false;
  private abandonedOpens = new Set<number>();
  constructor(
    readonly execution: BayExecution,
    cwd: string,
  ) {
    this.id = `bay:${execution.socket}:${execution.recordId}:${execution.generation}`;
    this.cwd = posix.resolve("/work", cwd);
  }
  private connect(): Promise<Duplex> {
    if (this.closed) return Promise.reject(this.closed);
    this.link ??= new Bay(this.execution.socket)
      .environment(this.execution, this.execution.agent.machineRevision, this.connectionAbort.signal)
      .then((stream) => {
        this.stream = stream;
        if (this.closed) {
          stream.destroy();
          throw this.closed;
        }
        void this.consume(stream);
        return stream;
      })
      .catch((error) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    return this.link;
  }
  private fail(error: Error): void {
    if (!this.closed) this.closed = error;
    this.stream?.destroy();
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  private async consume(stream: Duplex): Promise<void> {
    let bytes = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
        for (;;) {
          const index = bytes.indexOf(10);
          if (index < 0) break;
          if (index > 1024 * 1024) throw new Error("Bay environment frame exceeded its byte limit");
          const frame = JSON.parse(bytes.subarray(0, index).toString()) as Frame;
          if (!Number.isSafeInteger(frame.id) || frame.id < 1)
            throw new Error("Invalid Bay environment frame identity");
          if (
            frame.stream !== undefined &&
            ((frame.stream !== "stdout" && frame.stream !== "stderr") ||
              typeof frame.data !== "string" ||
              frame.data.length > Math.ceil(CHUNK / 3) * 4 ||
              Buffer.from(frame.data, "base64").toString("base64") !== frame.data)
          )
            throw new Error("Invalid Bay environment output frame");
          bytes = bytes.subarray(index + 1);
          const waiter = this.pending.get(frame.id);
          if (
            !waiter &&
            this.abandonedOpens.delete(frame.id) &&
            !this.disposing &&
            !frame.error &&
            Number.isSafeInteger(frame.value) &&
            Number(frame.value) > 0
          ) {
            void this.write({ id: ++this.sequence, op: "close", handle: frame.value }).catch((error) =>
              this.fail(error),
            );
          }
          if (!waiter) continue;
          if (frame.stream) {
            waiter.output?.(frame);
            continue;
          }
          this.pending.delete(frame.id);
          waiter.resolve(frame);
        }
        if (bytes.length > 1024 * 1024) throw new Error("Bay environment frame exceeded its byte limit");
      }
      this.fail(new Error("Bay execution connection closed"));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private write(frame: unknown): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const stream = await this.connect();
      const bytes = Buffer.from(JSON.stringify(frame) + "\n");
      if (!stream.write(bytes)) await once(stream, "drain");
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }
  private async rpc(
    op: string,
    params: Record<string, unknown>,
    context: Context,
    output?: (frame: Frame) => void,
  ): Promise<Frame> {
    if (this.disposing) throw new FileError("aborted", "Bay environment is closing");
    if (context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted");
    await this.connect();
    if (this.disposing || context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted");
    if (this.pending.size >= 128) throw new FileError("invalid", "Too many concurrent environment requests");
    const id = ++this.sequence;
    const request = { id, op, ...params };
    if (Buffer.byteLength(JSON.stringify(request)) + 1 > 1024 * 1024)
      throw new FileError("invalid", "Bay environment request exceeded its byte limit");
    return new Promise<Frame>((resolve, reject) => {
      let aborted = false;
      const abort = () => {
        aborted = true;
        if (op === "exec" && !this.disposing) {
          void this.write({ id: ++this.sequence, op: "cancel", handle: id }).catch((error) =>
            this.fail(error),
          );
        } else {
          this.pending.delete(id);
          if (["open", "openDir", "openWrite"].includes(op)) this.abandonedOpens.add(id);
          reject(new FileError("aborted", "Operation aborted"));
        }
      };
      this.pending.set(id, {
        resolve: (frame) => {
          context.abortSignal?.removeEventListener("abort", abort);
          if (aborted && op !== "exec") reject(new FileError("aborted", "Operation aborted"));
          else resolve(frame);
        },
        reject: (error) => {
          context.abortSignal?.removeEventListener("abort", abort);
          reject(error);
        },
        output,
      });
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      void this.write(request).catch((error) => this.fail(error));
      if (context.abortSignal?.aborted) abort();
    });
  }
  private async file<T>(
    op: string,
    params: Record<string, unknown>,
    context: Context,
    path?: string,
  ): Promise<Result<T, FileError>> {
    try {
      const frame = await this.rpc(op, params, context);
      if (frame.error)
        return failed(new FileError(frame.error.code as FileErrorCode, frame.error.message, path));
      return success(frame.value as T);
    } catch (error) {
      return failed(
        error instanceof FileError
          ? error
          : new FileError(
              context.abortSignal?.aborted ? "aborted" : "unknown",
              String(error),
              path,
              error instanceof Error ? error : undefined,
            ),
      );
    }
  }
  private path(path: string): string {
    return posix.resolve(this.cwd, path);
  }
  async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    return context.abortSignal?.aborted
      ? failed(new FileError("aborted", "Operation aborted"))
      : success(this.path(path));
  }
  async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
    return context.abortSignal?.aborted
      ? failed(new FileError("aborted", "Operation aborted"))
      : success(posix.join(...parts));
  }
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.file("info", { path: this.path(path) }, context, path);
  }
  canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.file("canonical", { path: this.path(path) }, context, path);
  }
  exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    return this.file("exists", { path: this.path(path) }, context, path);
  }
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file("mkdir", { path: this.path(path), ...options }, context, path);
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    return this.file("remove", { path: this.path(path), ...options }, context, path);
  }
  renameFile(source: string, destination: string, context: Context): Promise<Result<void, FileError>> {
    return this.file("rename", { path: this.path(source), to: this.path(destination) }, context, source);
  }
  truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    return this.file("truncate", { path: this.path(path), offset: size }, context, path);
  }
  flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.file("flush", { path: this.path(path) }, context, path);
  }
  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.file("tempDir", { prefix }, context);
  }
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.file("tempFile", { ...options }, context);
  }
  watch(
    _targets: readonly WatchTarget[],
    _onChange: (change: WatchChange) => void,
    _context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return Promise.resolve(failed(new FileError("not_supported", "Bay environments do not watch files")));
  }
  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.file<number>("open", { path: this.path(path), ...options }, context, path);
    if (!opened.ok) return opened;
    const handle = opened.value;
    let closed = false;
    const read = (offset: number, length: number, ctx: Context) =>
      this.file<string>("read", { handle, offset, length }, ctx, path).then((result) =>
        result.ok ? success<Uint8Array>(Buffer.from(result.value, "base64")) : result,
      );
    const reader: BinaryReader = {
      info: (ctx) => this.file("handleInfo", { handle }, ctx, path),
      read: async (offset, length, ctx) => {
        if (
          closed ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0
        )
          return failed(new FileError("invalid", "Invalid positional read", path));
        const pieces: Uint8Array[] = [];
        let remaining = length;
        while (remaining > 0) {
          const n = Math.min(remaining, CHUNK);
          const result = await read(offset, n, ctx);
          if (!result.ok) return result;
          pieces.push(result.value);
          offset += result.value.length;
          remaining -= result.value.length;
          if (result.value.length < n) break;
        }
        return success(Buffer.concat(pieces));
      },
      scanLines: async (options, ctx) => {
        try {
          const scanner = new LineScanner(options.startLine, options.endLine);
          for (let offset = 0; ; ) {
            const result = await read(offset, CHUNK, ctx);
            if (!result.ok) return result;
            scanner.push(result.value);
            offset += result.value.length;
            if (result.value.length < CHUNK) break;
          }
          return success(scanner.finish());
        } catch (error) {
          return failed(new FileError("invalid", String(error), path));
        }
      },
      close: async (ctx) => {
        if (closed) return;
        closed = true;
        await this.file("close", { handle }, withoutAbortSignal(ctx), path);
      },
    };
    return success(reader);
  }
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const opened = await this.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    try {
      const pieces: Uint8Array[] = [];
      for (let offset = 0; ; ) {
        const result = await opened.value.read(offset, CHUNK, context);
        if (!result.ok) return result;
        pieces.push(result.value);
        offset += result.value.length;
        if (result.value.length < CHUNK) break;
      }
      return success(Buffer.concat(pieces));
    } finally {
      await opened.value.close(context);
    }
  }
  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, context);
    return result.ok ? success(new TextDecoder().decode(result.value)) : result;
  }
  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const opened = await this.openBinaryReader(path, undefined, context);
    if (!opened.ok) return opened;
    let offset = 0,
      buffer = "",
      eof = false,
      closed = false;
    const decoder = new TextDecoder();
    return success({
      readLine: async (ctx) => {
        if (ctx.abortSignal?.aborted) return failed(new FileError("aborted", "Operation aborted", path));
        if (closed) return failed(new FileError("invalid", "Text line reader is closed", path));
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline >= 0) {
            const text = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            return success({ text, terminated: true });
          }
          if (eof) {
            if (!buffer) return success(undefined);
            const text = buffer;
            buffer = "";
            return success({ text, terminated: false });
          }
          const result = await opened.value.read(offset, CHUNK, ctx);
          if (!result.ok) return result;
          offset += result.value.length;
          eof = result.value.length < CHUNK;
          buffer += decoder.decode(result.value, { stream: !eof });
        }
      },
      close: async (ctx) => {
        closed = true;
        await opened.value.close(ctx);
      },
    });
  }
  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    try {
      const lines: string[] = [];
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return success(lines);
    } finally {
      await opened.value.close(context);
    }
  }
  private async writeFileMode(
    path: string,
    content: string | Uint8Array,
    append: boolean,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const parent = await this.createDir(posix.dirname(this.path(path)), { recursive: true }, context);
    if (!parent.ok) return parent;
    const opened = await this.file<number>("openWrite", { path: this.path(path), append }, context, path);
    if (!opened.ok) return opened;
    let result = success<void>(undefined);
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      result = await this.file<void>(
        "writeChunk",
        { handle: opened.value, data: bytes.subarray(offset, offset + CHUNK).toString("base64") },
        context,
        path,
      );
      if (!result.ok) break;
    }
    const closed = await this.file<void>(
      "close",
      { handle: opened.value },
      withoutAbortSignal(context),
      path,
    );
    return result.ok ? closed : result;
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.writeFileMode(path, content, false, context);
  }
  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.writeFileMode(path, content, true, context);
  }
  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const opened = await this.file<number>("openDir", { path: this.path(path) }, context, path);
    if (!opened.ok) return opened;
    let closed = false;
    return success({
      next: (maxEntries, ctx) =>
        this.file("next", { handle: opened.value, length: Math.min(maxEntries, 64) }, ctx, path),
      close: async (ctx) => {
        if (!closed) {
          closed = true;
          await this.file("close", { handle: opened.value }, withoutAbortSignal(ctx), path);
        }
      },
    });
  }
  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const opened = await this.openDirReader(path, context);
    if (!opened.ok) return opened;
    try {
      const entries: FileInfo[] = [];
      for (;;) {
        const page = await opened.value.next(64, context);
        if (!page.ok) return page;
        entries.push(...page.value.entries);
        if (page.value.done) return success(entries);
      }
    } finally {
      await opened.value.close(context);
    }
  }
  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (
      options?.timeout !== undefined &&
      (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647)
    )
      return { ok: false, error: new ExecutionError("timeout", "Invalid command timeout in seconds") };
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    let callbackError: Error | undefined;
    try {
      const frame = await this.rpc(
        "exec",
        {
          command,
          path: this.path(options?.cwd ?? this.cwd),
          env: options?.env,
          inheritEnv: options?.inheritEnv,
          timeoutMs: options?.timeout === undefined ? undefined : Math.ceil(options.timeout * 1000),
          spill: options?.spill,
        },
        context,
        (frame) => {
          if (!frame.stream) return;
          const text = decoders[frame.stream].decode(Buffer.from(frame.data ?? "", "base64"), {
            stream: true,
          });
          if (!text || callbackError) return;
          try {
            options?.onOutput?.(text, context, { stream: frame.stream });
          } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
            void this.write({ id: ++this.sequence, op: "cancel", handle: frame.id }).catch((error) =>
              this.fail(error),
            );
          }
        },
      );
      for (const stream of ["stdout", "stderr"] as const) {
        const text = decoders[stream].decode();
        if (text && !callbackError) {
          try {
            options?.onOutput?.(text, context, { stream });
          } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
          }
        }
      }
      const result = frame.value as ShellExecResult | undefined;
      if (callbackError) {
        const error = new ExecutionError("callback_error", callbackError.message, callbackError);
        error.spillPath = result?.spillPath;
        return { ok: false, error };
      }
      if (frame.error) {
        const code = ["aborted", "timeout", "shell_unavailable", "spawn_error"].includes(frame.error.code)
          ? (frame.error.code as "aborted" | "timeout" | "shell_unavailable" | "spawn_error")
          : "unknown";
        const error = new ExecutionError(code, frame.error.message);
        error.spillPath = result?.spillPath;
        return { ok: false, error };
      }
      if (!result || !Number.isInteger(result.exitCode)) throw new Error("Invalid Bay command exit receipt");
      return { ok: true, value: result };
    } catch (cause) {
      return {
        ok: false,
        error: new ExecutionError(
          context.abortSignal?.aborted ? "aborted" : "unknown",
          String(cause),
          cause instanceof Error ? cause : undefined,
        ),
      };
    }
  }
  cleanup(_context?: Context): Promise<void> {
    this.closing ??= this.closeConnection();
    return this.closing;
  }
  private async closeConnection(): Promise<void> {
    this.disposing = true;
    if (this.closed) {
      if (this.stream && !this.stream.readableEnded) throw this.closed;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Bay environment cleanup was not acknowledged")), 10_000);
    });
    try {
      if (!this.stream) {
        this.closed = new Error("Bay environment closed");
        this.connectionAbort.abort();
        await this.link?.catch(() => {});
        return;
      }
      // Finish already queued frames before EOF; new calls are refused above.
      await Promise.race([this.writeQueue, deadline]);
      const stream = this.stream;
      if (this.closed || stream.readableEnded) {
        if (!stream.readableEnded) throw this.closed;
        return;
      }
      this.closed = new Error("Bay environment closed");
      for (const waiter of this.pending.values()) waiter.reject(this.closed);
      this.pending.clear();
      // EOF follows the helper's command cleanup, unlike a local socket close.
      const ended = new Promise<void>((resolve, reject) => {
        stream.once("end", resolve);
        stream.once("error", reject);
        stream.once("close", () => {
          if (!stream.readableEnded) reject(new Error("Bay environment closed without its cleanup receipt"));
        });
      });
      stream.end();
      await Promise.race([ended, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      this.stream?.destroy();
      this.connectionAbort.abort();
    }
  }

  close(): Promise<void> {
    return this.cleanup();
  }
}
