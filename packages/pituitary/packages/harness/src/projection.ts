import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  type AgentSnapshot,
  encodeJsonLine,
  type PiEvent,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type SessionStats,
} from "@pituitary/rpc";
import {
  type ClientRecord,
  isReadCommand,
  MAX_CLIENT_BACKLOG_BYTES,
  type ServerRecord,
  WORKER_PROTOCOL_VERSION,
  type WorkerCommand,
  type WorkerIdentity,
  WorkerRecordDecoder,
} from "./protocol.ts";
import { privateDirectory } from "./store.ts";
import type { WorkerClient } from "./worker-client.ts";

export interface Projection {
  close(): Promise<void>;
}
export interface ConversationArchive {
  schemaVersion: 1;
  capturedAt: string;
  identity: WorkerIdentity;
  snapshot: AgentSnapshot;
  stats: SessionStats | null;
}
interface ProjectionSource {
  readonly identity: WorkerIdentity;
  getSnapshot?: () => Promise<AgentSnapshot>;
  request(command: WorkerCommand, id: string): Promise<unknown>;
  respond(response: RpcExtensionUIResponse): void;
  onEvent(listener: (event: PiEvent, sequence?: number) => void): () => void;
  onUiRequest(listener: (request: RpcExtensionUIRequest) => void): () => void;
  onUiClose(listener: (id: string) => void): () => void;
}
const INTERRUPTS = new Set(["abort", "abort_bash", "abort_retry", "clear_queue"]);
const RUNTIME_COMMANDS = new Set(["initialize", "shutdown", "deliver", "credentials"]);

/** A disposable frontend owns input only while the host's attempt still permits it. */
export async function projectWorker(
  path: string,
  worker: WorkerClient,
  options: { canWrite?: () => boolean } = {},
): Promise<Projection> {
  return project(path, worker, options.canWrite ?? (() => true));
}

async function project(path: string, worker: ProjectionSource, canWrite: () => boolean): Promise<Projection> {
  const peers = new Set<Socket>(),
    handshakes = new Set<Socket>();
  const dialogs = new Map<string, RpcExtensionUIRequest>(),
    display = new Map<string, string>();
  let controller: Socket | null = null,
    sequence = 0,
    inFlight = 0;
  let closing: Promise<void> | undefined;
  let socketIdentity: { dev: number; ino: number } | undefined;
  const send = (socket: Socket, record: ServerRecord) => {
    if (socket.destroyed) return;
    if (socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(encodeJsonLine(record));
  };
  const broadcast = (record: ServerRecord) => {
    for (const peer of peers) send(peer, record);
  };
  const cleanups = [
    worker.onEvent((event, cursor) => {
      sequence = cursor ?? sequence + 1;
      broadcast({ type: "event", sequence, event });
    }),
    worker.onUiRequest((request) => {
      const key =
        request.method === "setStatus"
          ? "status:" + request.statusKey
          : request.method === "setWidget"
            ? "widget:" + request.widgetKey
            : request.method === "setTitle"
              ? "title"
              : null;
      if (key) {
        const previous = display.get(key);
        if (previous) dialogs.delete(previous);
        display.set(key, request.id);
      }
      if (!["notify", "set_editor_text"].includes(request.method)) dialogs.set(request.id, request);
      broadcast({ type: "ui", sequence: ++sequence, request });
    }),
    worker.onUiClose((id) => {
      dialogs.delete(id);
      broadcast({ type: "ui_closed", sequence: ++sequence, id });
    }),
  ];
  const server = createServer((socket) => {
    if (handshakes.size + peers.size >= 32) {
      socket.destroy();
      return;
    }
    handshakes.add(socket);
    const active = new Set<string>();
    const decoder = new WorkerRecordDecoder();
    let accepted = false;
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(deadline);
      handshakes.delete(socket);
      peers.delete(socket);
      if (controller === socket) controller = null;
    });
    socket.on("data", (chunk) => {
      try {
        for (const line of decoder.push(Buffer.from(chunk))) {
          const record = JSON.parse(line) as ClientRecord;
          if (!record || typeof record !== "object") throw new Error("Invalid frontend record");
          if (!accepted) {
            if (
              record.type !== "hello" ||
              record.version !== WORKER_PROTOCOL_VERSION ||
              typeof record.control !== "boolean" ||
              ("supervisor" in record && record.supervisor)
            ) {
              send(socket, { type: "rejected", error: "Expected a frontend connection" });
              socket.end();
              return;
            }
            const control = record.control && canWrite();
            if (control && controller) {
              send(socket, { type: "rejected", error: "Another frontend holds the input lease" });
              socket.end();
              return;
            }
            if (peers.size >= 16) {
              send(socket, { type: "rejected", error: "Too many attached frontends" });
              socket.end();
              return;
            }
            if (control) controller = socket;
            accepted = true;
            clearTimeout(deadline);
            handshakes.delete(socket);
            peers.add(socket);
            send(socket, {
              type: "welcome",
              worker: worker.identity,
              control,
              sequence,
              uiRequests: [...dialogs.values()],
              capabilities: [
                ...(worker.getSnapshot ? ["atomic-snapshot"] : []),
                ...(worker.identity.archived ? ["archive"] : []),
              ],
            });
            continue;
          }
          if (record.type === "answer") {
            if (
              controller === socket &&
              canWrite() &&
              record.response &&
              typeof record.response.id === "string" &&
              dialogs.has(record.response.id)
            )
              worker.respond(record.response);
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
            throw new Error("Invalid frontend command");
          const { id, command } = record;
          const write = !isReadCommand(command);
          const blocked = RUNTIME_COMMANDS.has(command.type);
          if (blocked || (write && (controller !== socket || !canWrite()))) {
            send(socket, {
              type: "result",
              id,
              success: false,
              error: blocked
                ? "This operation belongs to the runtime"
                : worker.identity.archived
                  ? "This conversation is archived and read-only"
                  : "This frontend cannot change this attempt",
            });
            continue;
          }
          // Reserve a few slots for interruption even when ordinary requests are saturated.
          const reserve = INTERRUPTS.has(command.type) ? 4 : 0;
          if (active.has(id) || active.size >= 32 + reserve || inFlight >= 128 + reserve) {
            send(socket, {
              type: "result",
              id,
              success: false,
              error: active.has(id) ? "Command ID is already pending" : "Too many pending frontend commands",
            });
            continue;
          }
          active.add(id);
          inFlight++;
          void worker
            .request(command, id)
            .then(
              (data) => send(socket, { type: "result", id, success: true, data }),
              (error) =>
                send(socket, {
                  type: "result",
                  id,
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
            )
            .finally(() => {
              active.delete(id);
              inFlight--;
            });
        }
      } catch {
        socket.destroy();
      }
    });
  });
  try {
    try {
      const info = lstatSync(path);
      if (!info.isSocket() || info.uid !== process.getuid?.())
        throw new Error("Projection socket is occupied");
      rmSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
    socketIdentity = lstatSync(path);
  } catch (error) {
    for (const off of cleanups) off();
    throw error;
  }
  return {
    close: () => {
      closing ??= (async () => {
        for (const off of cleanups) off();
        for (const peer of [...handshakes, ...peers]) peer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
          const current = lstatSync(path);
          if (current.dev === socketIdentity?.dev && current.ino === socketIdentity?.ino) rmSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      })();
      return closing;
    },
  };
}

/** Capture before shutting down a worker. This never resumes an environment or invokes a model. */
export async function archiveWorker(directory: string, worker: WorkerClient): Promise<ConversationArchive> {
  if (!worker.getSnapshot) throw new Error("Worker cannot provide an atomic conversation snapshot");
  const snapshot = (await worker.request({ type: "get_snapshot" }, randomUUID(), 2000)) as AgentSnapshot;
  const stats = await worker
    .request({ type: "get_session_stats" }, randomUUID(), 1000)
    .then((value) => value as SessionStats)
    .catch(() => null);
  const archive: ConversationArchive = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    identity: {
      ...worker.identity,
      sessionId: snapshot.state.sessionId,
      sessionFile: snapshot.state.sessionFile,
    },
    snapshot,
    stats,
  };
  privateDirectory(directory);
  const path = join(directory, "conversation.json"),
    temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(archive) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const parent = openSync(directory, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return archive;
}

export function readArchive(directory: string): ConversationArchive | null {
  const path = join(directory, "conversation.json");
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.size > 32 * 1024 * 1024
  )
    throw new Error("Invalid conversation archive file");
  const archive = JSON.parse(readFileSync(path, "utf8")) as ConversationArchive;
  if (
    !archive ||
    archive.schemaVersion !== 1 ||
    !archive.identity ||
    !archive.snapshot ||
    !archive.snapshot.state ||
    !Array.isArray(archive.snapshot.messages) ||
    !Array.isArray(archive.snapshot.pendingToolCalls) ||
    archive.snapshot.state.sessionId !== archive.identity.sessionId
  )
    throw new Error("Invalid conversation archive");
  return archive;
}

export function projectArchive(path: string, archive: ConversationArchive): Promise<Projection> {
  const snapshot = structuredClone(archive.snapshot);
  // A captured partial reply becomes interrupted display history. Native history remains
  // unchanged; an already-finalized message takes precedence over its streaming copy.
  const partial = snapshot.streamingMessage as { role?: string; timestamp?: number } | undefined;
  if (partial?.role === "assistant") {
    const finalized = snapshot.messages.some((value) => {
      const message = value as { role?: string; timestamp?: number } | null;
      return (
        message?.role === "assistant" &&
        (partial.timestamp !== undefined
          ? message.timestamp === partial.timestamp
          : JSON.stringify(message) === JSON.stringify(partial))
      );
    });
    if (!finalized) snapshot.messages = [...snapshot.messages, { ...partial, stopReason: "aborted" }];
  }
  delete snapshot.streamingMessage;
  snapshot.state = { ...snapshot.state, isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  snapshot.pendingToolCalls = [];
  snapshot.queue = { steering: [], followUp: [] };
  const source: ProjectionSource = {
    identity: { ...archive.identity, version: WORKER_PROTOCOL_VERSION, archived: true },
    getSnapshot: async () => snapshot,
    request: async (command) => {
      switch (command.type) {
        case "get_snapshot":
          return snapshot;
        case "get_state":
          return snapshot.state;
        case "get_messages":
          return { messages: snapshot.messages };
        case "get_session_stats":
          if (!archive.stats)
            throw new Error("Statistics were unavailable when this conversation was archived");
          return archive.stats;
        case "get_commands":
          return { commands: [] };
        case "get_available_models":
          return { models: snapshot.state.model ? [snapshot.state.model] : [] };
        case "get_available_thinking_levels":
          return { levels: [snapshot.state.thinkingLevel] };
        case "get_last_assistant_text":
          return { text: lastAssistantText(snapshot.messages) };
        default:
          throw new Error("This operation requires a live attempt; the conversation is archived");
      }
    },
    respond: () => {},
    onEvent: () => () => {},
    onUiRequest: () => () => {},
    onUiClose: () => () => {},
  };
  return project(path, source, () => false);
}

function lastAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  return null;
}
