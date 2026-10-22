#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { encodeJsonLine, type RpcExtensionUIRequest, type RpcSessionState } from "@pituitary/rpc";
import { createNativeEngine } from "./pi-engine.ts";
import {
  type ClientRecord,
  canonical,
  isReadCommand,
  MAX_CLIENT_BACKLOG_BYTES,
  type ServerRecord,
  WORKER_PROTOCOL_VERSION,
  type WorkerCommand,
  type WorkerEngine,
  type WorkerEngineContext,
  type WorkerIdentity,
  WorkerRecordDecoder,
} from "./protocol.ts";

export type { WorkerEngine, WorkerEngineContext } from "./protocol.ts";

export interface StartWorkerOptions {
  socketPath: string;
  stateDirectory: string;
  cwd: string;
  sessionFile?: string;
  model?: string;
  instructions?: string;
  configDirectory?: string;
  authFile?: string;
  engineFactory?: (context: WorkerEngineContext) => Promise<WorkerEngine>;
}

export interface Worker {
  socketPath: string;
  readonly identity: WorkerIdentity;
  close(): Promise<void>;
  /** Resolves after explicit shutdown, never merely because a client detached. */
  stopped: Promise<void>;
}

interface LedgerEntry {
  id: string;
  payload: string;
  response?: Extract<ServerRecord, { type: "result" }>;
}

const LEDGER_CAPACITY = 4096;
const LEDGER_MAX_BYTES = 16 * 1024 * 1024;
/** Pending effects retain room for a bounded outcome even if another receipt is large. */
const RECEIPT_RESERVE_BYTES = 64 * 1024;

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function privateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
    throw new Error(`worker directory must belong to this user: ${path}`);
  }
  if ((info.mode & 0o077) !== 0) throw new Error(`worker directory must be private (0700): ${path}`);
}

/** One process owns one native conversation; terminal connections are disposable. */
export async function startWorker(options: StartWorkerOptions): Promise<Worker> {
  const stateDirectory = resolve(options.stateDirectory);
  const socketPath = resolve(options.socketPath);
  privateDirectory(stateDirectory);
  privateDirectory(dirname(socketPath));
  const lockPath = join(stateDirectory, "worker.lock");
  const lock = () => {
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(fd, String(process.pid));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  try {
    lock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const alive = () => {
      const pid = Number(readFileSync(lockPath, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("worker lock is malformed");
      try {
        process.kill(pid, 0);
        return pid;
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
        return null;
      }
    };
    const owner = alive();
    if (owner !== null) throw new Error(`worker state is already owned by process ${owner}`);
    // Serialize stale-lock reclamation; otherwise two rescuers can unlink each other's new lock.
    const reclaim = join(stateDirectory, "worker.reclaim");
    try {
      mkdirSync(reclaim, { mode: 0o700 });
    } catch {
      throw new Error("worker lock recovery is already in progress; inspect worker.reclaim before retrying");
    }
    try {
      if (existsSync(lockPath)) {
        const current = alive();
        if (current !== null) throw new Error(`worker state is already owned by process ${current}`);
        unlinkSync(lockPath);
      }
      lock();
    } finally {
      rmSync(reclaim, { recursive: true });
    }
  }

  const metadataPath = join(stateDirectory, "worker.json");
  const ledgerPath = join(stateDirectory, "commands.json");
  let engine: WorkerEngine | undefined;
  const sockets = new Set<Socket>();
  const connections = new Set<Socket>();
  let controller: Socket | null = null;
  let sequence = 0;
  let closing: Promise<void> | null = null;
  let stopped!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const pending = new Map<string, Promise<Extract<ServerRecord, { type: "result" }>>>();
  const uiRequests = new Map<string, RpcExtensionUIRequest>();
  const displayIds = new Map<string, string>();
  const dialogDeadlines = new Map<string, number>();
  const ledger = new Map<string, LedgerEntry>();
  const ledgerBytes = () =>
    Buffer.byteLength(JSON.stringify([...ledger.values()])) +
    1 +
    [...ledger.values()].filter((entry) => !entry.response).length * RECEIPT_RESERVE_BYTES;
  const saveLedger = () => atomicJson(ledgerPath, [...ledger.values()]);
  let identity: WorkerIdentity;
  let boundSessionId: string | undefined;
  const server = createServer();

  const send = (socket: Socket, record: ServerRecord) => {
    if (socket.destroyed) return;
    if (socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(encodeJsonLine(record));
  };
  const publish = (record: ServerRecord) => {
    for (const socket of sockets) send(socket, record);
  };
  const uiClose = (id: string) => {
    dialogDeadlines.delete(id);
    if (!uiRequests.delete(id)) return;
    publish({ type: "ui_closed", sequence: ++sequence, id });
  };
  const snapshotUi = () => {
    const snapshot: RpcExtensionUIRequest[] = [];
    for (const [id, request] of uiRequests) {
      const deadline = dialogDeadlines.get(id);
      if (deadline !== undefined && deadline <= Date.now()) {
        uiRequests.delete(id);
        dialogDeadlines.delete(id);
      } else {
        snapshot.push(
          deadline === undefined
            ? request
            : ({ ...request, timeout: Math.max(1, deadline - Date.now()) } as RpcExtensionUIRequest),
        );
      }
    }
    return snapshot;
  };
  const remember = async () => {
    if (!engine) return;
    const state = (await engine.call({ type: "get_state" })) as RpcSessionState;
    if (boundSessionId !== undefined && state.sessionId !== boundSessionId)
      throw new Error(
        "the native conversation changed; explicit recovery is required before reusing command receipts",
      );
    boundSessionId ??= state.sessionId;
    if (state.sessionFile && existsSync(state.sessionFile)) {
      const transcript = openSync(state.sessionFile, "r");
      try {
        fsyncSync(transcript);
      } finally {
        closeSync(transcript);
      }
    }
    identity = { ...identity, sessionId: state.sessionId, sessionFile: state.sessionFile };
    atomicJson(metadataPath, identity);
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      for (const socket of connections) socket.destroy();
      sockets.clear();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await engine?.close();
        await Promise.allSettled([...pending.values()]);
        await remember();
      } finally {
        rmSync(socketPath, { force: true });
        rmSync(lockPath, { force: true });
        stopped();
      }
    })();
    return closing;
  };

  try {
    let previous: WorkerIdentity | undefined;
    if (existsSync(metadataPath)) previous = JSON.parse(readFileSync(metadataPath, "utf8")) as WorkerIdentity;
    if (previous && previous.cwd !== resolve(options.cwd))
      throw new Error("worker state belongs to another directory");
    if (
      previous &&
      options.sessionFile &&
      (!previous.sessionFile || resolve(options.sessionFile) !== resolve(previous.sessionFile))
    )
      throw new Error("existing worker state cannot be rebound to another native session");
    boundSessionId = previous?.sessionId;
    if (existsSync(ledgerPath)) {
      if (statSync(ledgerPath).size > LEDGER_MAX_BYTES)
        throw new Error(
          "worker command ledger exceeds its byte limit; inspect the saved state before recovery",
        );
      const entries = JSON.parse(readFileSync(ledgerPath, "utf8")) as LedgerEntry[];
      if (!Array.isArray(entries) || entries.length > LEDGER_CAPACITY)
        throw new Error("invalid worker command ledger");
      for (const entry of entries) {
        if (typeof entry.id !== "string" || typeof entry.payload !== "string")
          throw new Error("invalid worker command receipt");
        if (!entry.response) {
          entry.response = {
            type: "result",
            id: entry.id,
            success: false,
            error:
              "command outcome is uncertain after worker interruption; inspect the session before retrying with a new command ID",
          };
        }
        ledger.set(entry.id, entry);
      }
    }
    identity = {
      version: WORKER_PROTOCOL_VERSION,
      incarnation: randomUUID(),
      pid: process.pid,
      cwd: resolve(options.cwd),
      sessionId: previous?.sessionId ?? randomUUID(),
    };
    engine = await (options.engineFactory ?? createNativeEngine)({
      cwd: identity.cwd,
      stateDirectory,
      sessionFile: options.sessionFile ?? previous?.sessionFile,
      sessionId: previous?.sessionId,
      model: options.model,
      instructions: options.instructions,
      configDirectory: options.configDirectory,
      authFile: options.authFile,
      onEvent: (event) => {
        publish({ type: "event", sequence: ++sequence, event });
        if (event.type === "agent_settled" || event.type === "session_info_changed") {
          void remember().catch(() => {});
        }
      },
      onUiRequest: (request) => {
        if ("timeout" in request && request.timeout && request.timeout > 0)
          dialogDeadlines.set(request.id, Date.now() + request.timeout);
        const key =
          request.method === "setStatus"
            ? `status:${request.statusKey}`
            : request.method === "setWidget"
              ? `widget:${request.widgetKey}`
              : request.method === "setTitle"
                ? "title"
                : undefined;
        if (key) {
          const previous = displayIds.get(key);
          if (previous) uiRequests.delete(previous);
          displayIds.set(key, request.id);
        }
        // Editor edits and notifications are actions, not state to repeat on attachment.
        if (request.method !== "notify" && request.method !== "set_editor_text")
          uiRequests.set(request.id, request);
        publish({ type: "ui", sequence: ++sequence, request });
      },
      onUiClose: uiClose,
    });
    await remember();
    if (existsSync(socketPath)) {
      const info = lstatSync(socketPath);
      if (!info.isSocket() || info.uid !== process.getuid?.())
        throw new Error("worker socket path is already occupied");
      const live = await new Promise<boolean>((resolve) => {
        const probe = connect(socketPath);
        probe.once("connect", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", (error) => {
          probe.destroy();
          resolve((error as NodeJS.ErrnoException).code !== "ECONNREFUSED");
        });
      });
      if (live) throw new Error("worker socket is already listening");
      unlinkSync(socketPath);
    }

    const execute = async (
      id: string,
      command: WorkerCommand,
    ): Promise<Extract<ServerRecord, { type: "result" }>> => {
      const existing = ledger.get(id);
      const payload = canonical(command);
      if (existing) {
        if (existing.payload !== payload)
          throw new Error(`command ID ${id} was already used with another payload`);
        if (existing.response) return existing.response;
        const running = pending.get(id);
        if (running) return running;
        throw new Error("command outcome is uncertain");
      }
      const recorded = !isReadCommand(command) && command.type !== "shutdown";
      if (recorded) {
        if (ledger.size >= LEDGER_CAPACITY)
          throw new Error("worker command ledger is full; start a new worker state directory");
        ledger.set(id, { id, payload });
        if (ledgerBytes() > LEDGER_MAX_BYTES) {
          ledger.delete(id);
          throw new Error(
            "worker command ledger byte capacity is full; start a new run before sending more work",
          );
        }
        saveLedger();
      }
      const operation = (async (): Promise<Extract<ServerRecord, { type: "result" }>> => {
        let response: Extract<ServerRecord, { type: "result" }>;
        try {
          // A bash update's UI correlation ID is separate from the durable transport receipt.
          let data: unknown;
          if (command.type === "get_snapshot") {
            if (!engine?.snapshot) throw new Error("this worker engine does not support an atomic snapshot");
            data = { ...engine.snapshot(), sequence };
          } else if (command.type !== "shutdown") {
            data = await engine?.call({ ...command, id: command.id ?? id });
          }
          response = { type: "result", id, success: true, data };
          if (recorded) await remember();
        } catch (cause) {
          response = { type: "result", id, success: false, error: describe(cause) };
        }
        if (recorded) {
          ledger.set(id, { id, payload, response });
          if (ledgerBytes() > LEDGER_MAX_BYTES) {
            response = {
              type: "result",
              id,
              success: false,
              error:
                "command executed but its result exceeded receipt capacity; inspect the native conversation before retrying with a new command ID",
            };
            ledger.set(id, { id, payload, response });
          }
          saveLedger();
        }
        return response;
      })();
      pending.set(id, operation);
      try {
        return await operation;
      } finally {
        pending.delete(id);
      }
    };

    server.on("connection", (socket) => {
      connections.add(socket);
      const decoder = new WorkerRecordDecoder();
      let accepted = false;
      let rejected = false;
      const timer = setTimeout(() => socket.destroy(), 5000);
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(timer);
        sockets.delete(socket);
        connections.delete(socket);
        if (controller === socket) controller = null;
      });
      socket.on("data", (chunk: Buffer) => {
        if (rejected) return;
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const line of lines) {
          let record: ClientRecord;
          try {
            record = JSON.parse(line) as ClientRecord;
            if (!record || typeof record !== "object") throw new Error("invalid worker record");
            if (!accepted) {
              if (
                record.type !== "hello" ||
                record.version !== WORKER_PROTOCOL_VERSION ||
                typeof record.control !== "boolean"
              ) {
                throw new Error(`worker protocol ${WORKER_PROTOCOL_VERSION} handshake required`);
              }
              if (record.control && controller && !controller.destroyed)
                throw new Error("another client controls this worker; detach it before taking control");
              if (record.control) controller = socket;
              accepted = true;
              clearTimeout(timer);
              sockets.add(socket);
              send(socket, {
                type: "welcome",
                worker: identity,
                control: record.control,
                sequence,
                uiRequests: snapshotUi(),
                capabilities: [
                  "pi-sdk",
                  "durable-commands",
                  "detach",
                  "dialogs",
                  "single-controller",
                  ...(engine?.snapshot ? ["atomic-snapshot"] : []),
                ],
              });
              continue;
            }
            if (record.type === "answer") {
              if (controller !== socket) throw new Error("this connection does not control worker input");
              if (!record.response || typeof record.response.id !== "string")
                throw new Error("invalid dialog answer");
              if (!uiRequests.has(record.response.id)) throw new Error("dialog is no longer open");
              engine?.respond(record.response);
              uiClose(record.response.id);
              continue;
            }
            if (
              record.type !== "command" ||
              typeof record.id !== "string" ||
              !record.id ||
              record.id.length > 256 ||
              !record.command ||
              typeof record.command.type !== "string"
            )
              throw new Error("invalid worker command");
            const { id, command } = record;
            if (controller !== socket && command.type !== "shutdown" && !isReadCommand(command)) {
              send(socket, {
                type: "result",
                id,
                success: false,
                error: "this connection does not control worker input",
              });
              continue;
            }
            void execute(id, command).then(
              (response) => {
                if (command.type === "shutdown" && response.success) {
                  socket.write(encodeJsonLine(response), () => void close());
                } else send(socket, response);
              },
              (cause) => send(socket, { type: "result", id, success: false, error: describe(cause) }),
            );
          } catch (cause) {
            rejected = true;
            socket.end(encodeJsonLine({ type: "rejected", error: describe(cause) }));
            return;
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    return {
      socketPath,
      get identity() {
        return identity;
      },
      close,
      stopped: stopping,
    };
  } catch (error) {
    try {
      await engine?.close();
    } finally {
      rmSync(lockPath, { force: true });
    }
    throw error;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: pituitary-worker serve --socket PATH --state DIR --cwd DIR\n       pituitary-worker connect --socket PATH\n\nserve keeps one native Pi session alive independently of its clients.\nconnect relays the versioned worker protocol over stdin/stdout. Disconnecting detaches.\n\nServe options: --session PATH --model PROVIDER/MODEL --instructions-file PATH\n",
    );
    return;
  }
  const mode = argv[0] === "serve" || argv[0] === "connect" ? argv.shift() : "serve";
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag ||
      !["--socket", "--state", "--cwd", "--session", "--model", "--instructions-file"].includes(flag) ||
      value === undefined
    )
      throw new Error(
        "usage: pituitary-worker serve --socket PATH --state DIR --cwd DIR | connect --socket PATH",
      );
    values.set(flag, value);
  }
  const socketPath = values.get("--socket");
  if (!socketPath) throw new Error("--socket is required");
  if (mode === "connect") {
    const socket = connect(socketPath);
    socket.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    await new Promise<void>((resolve) =>
      socket.once("close", () => {
        process.stdin.unpipe(socket);
        process.stdin.pause();
        resolve();
      }),
    );
    return;
  }
  const stateDirectory = values.get("--state");
  const cwd = values.get("--cwd");
  if (!stateDirectory || !cwd) throw new Error("--state and --cwd are required");
  const instructionsFile = values.get("--instructions-file");
  const worker = await startWorker({
    socketPath,
    stateDirectory,
    cwd,
    sessionFile: values.get("--session"),
    model: values.get("--model"),
    instructions: instructionsFile ? readFileSync(instructionsFile, "utf8") : undefined,
  });
  const stop = () => {
    void worker.close();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  await worker.stopped;
  EventEmitter.prototype.removeListener.call(process, "SIGTERM", stop);
  EventEmitter.prototype.removeListener.call(process, "SIGINT", stop);
  EventEmitter.prototype.removeListener.call(process, "SIGHUP", stop);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`pituitary-worker: ${describe(cause)}\n`);
    process.exitCode = 1;
  });
}
