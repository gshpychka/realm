import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectSocket } from "node:net";
import { dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentCatalog } from "./catalog.ts";
import type { ConversationCommand, ConversationUpdate } from "./conversation.ts";
import {
  CONVERSATION_CAPABILITIES,
  type ConversationBridge,
  openConversation,
} from "./conversation-bridge.ts";
import type { ReviseTaskInput, RunDetail, RunLimits, StartRunInput } from "./model.ts";
import { DomainDoc, Orchestrator } from "./orchestrator.ts";
import { runtimeSocket } from "./client.ts";
import { privateDirectory, socketDirectory } from "./paths.ts";

export interface SupervisorOptions {
  stateDirectory: string;
  catalog?: AgentCatalog;
  catalogFile?: string;
  environment?: NodeJS.ProcessEnv;
  limits?: Partial<RunLimits>;
  models?: Models;
}
export interface RuntimeHandle {
  close(): Promise<void>;
}
interface Attachment {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  conversationId: ConversationId;
  control: boolean;
  archived: boolean;
  bridge: ConversationBridge;
  response: ServerResponse;
  active: Set<Promise<unknown>>;
}
const READ = new Set([
  "get_snapshot",
  "get_state",
  "get_messages",
  "get_session_stats",
  "get_available_models",
  "get_available_thinking_levels",
  "get_last_assistant_text",
]);

/** The private HTTP socket is the sole host entry point, including through an SSH tunnel. */
export async function startRuntime(options: SupervisorOptions): Promise<RuntimeHandle> {
  const root = resolve(options.stateDirectory),
    socket = runtimeSocket(root);
  privateDirectory(root);
  privateDirectory(dirname(socketDirectory(root)));
  privateDirectory(socketDirectory(root));
  const attachments = new Map<string, Attachment>(),
    input = new Map<ConversationId, Promise<void> | null>();
  const shutdown = new AbortController();
  let preparing = 0,
    draining = 0;
  let closing = false,
    orchestrator: Orchestrator | undefined;
  let unwatchAuthority = () => {};
  const routes = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const operation = route(request, response).catch((error) => {
      if (!response.headersSent)
        reply(response, error instanceof HttpError ? error.status : 400, { error: message(error) });
      else response.destroy();
    });
    routes.add(operation);
    void operation.finally(() => routes.delete(operation));
  });
  const detachments = new Set<Promise<void>>();
  const closeAttachment = (id: string): Promise<void> => {
    const current = attachments.get(id);
    if (!current) return Promise.resolve();
    attachments.delete(id);
    draining++;
    const completion = (async () => {
      try {
        await Promise.allSettled([...current.active]);
        await current.bridge.close();
      } finally {
        draining--;
        if (current.control) input.delete(current.conversationId);
        current.response.end();
      }
    })();
    if (current.control) input.set(current.conversationId, completion);
    detachments.add(completion);
    void completion.finally(() => detachments.delete(completion)).catch(() => {});
    return completion;
  };
  async function conversation(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    taskId: string,
    control: boolean,
  ): Promise<void> {
    if (attachments.size + preparing + draining >= 32)
      throw new HttpError(429, "Too many conversation views; close an existing view");
    preparing++;
    try {
      await openView(request, response, runId, taskId, control);
    } finally {
      preparing--;
    }
  }
  async function openView(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    taskId: string,
    control: boolean,
  ): Promise<void> {
    if (!orchestrator) throw new HttpError(503, "Runtime is opening its durable storage");
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    const context = withAbortSignal(AbortSignal.any([abort.signal, shutdown.signal]), BACKGROUND_CONTEXT);
    let target = await orchestrator.waitConversation(runId, taskId, context);
    const previous = control ? input.get(target.conversation.id) : undefined;
    if (previous) {
      await previous;
      target = await orchestrator.conversation(runId, taskId);
    }
    context.abortSignal?.throwIfAborted();
    const writes = control && target.canWrite;
    if (writes && input.has(target.conversation.id))
      throw new HttpError(409, "Another frontend holds this conversation's input lease");
    if (writes) input.set(target.conversation.id, null);
    const id = randomUUID(),
      pending: ConversationUpdate[] = [];
    let welcomed = false,
      pendingBytes = 0,
      detached = false;
    const detach = () => {
      detached = true;
      void closeAttachment(id);
    };
    request.once("aborted", detach);
    response.once("close", detach);
    let bridge: ConversationBridge | undefined;
    try {
      const send = (record: ConversationUpdate): void => {
        if (detached || response.destroyed) return;
        const bytes = `${JSON.stringify(record)}\n`;
        if (!welcomed) {
          pendingBytes += Buffer.byteLength(bytes);
          if (pendingBytes > 32 * 1024 * 1024)
            throw new Error("Conversation changed too quickly while opening; reconnect");
          pending.push(record);
          return;
        }
        // One image input can publish two full-sized records (message start/end).
        if (response.writableLength > 32 * 1024 * 1024) {
          response.destroy(new Error("Conversation observer fell behind; reconnect for a fresh snapshot"));
          return;
        }
        response.write(bytes);
      };
      bridge = await openConversation({
        harness: orchestrator.harness,
        conversation: target.conversation,
        models: orchestrator.models,
        identity: target.identity,
        control: writes,
        onRecord: send,
      });
      const snapshot = await bridge.snapshot();
      if (detached || closing) {
        await bridge.close();
        if (writes) input.delete(target.conversation.id);
        return;
      }
      const welcome = `${JSON.stringify({
        type: "welcome",
        id,
        identity: target.identity,
        control: writes,
        capabilities: CONVERSATION_CAPABILITIES,
        snapshot,
      })}\n`;
      if (Buffer.byteLength(welcome) > 16 * 1024 * 1024)
        throw new Error("Conversation snapshot exceeds its display limit");
      attachments.set(id, {
        id,
        runId,
        taskId,
        attemptId: target.identity.attemptId,
        conversationId: target.conversation.id,
        control: writes,
        archived: target.identity.archived,
        bridge,
        response,
        active: new Set(),
      });
      response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      response.write(welcome);
      welcomed = true;
      for (const record of pending) send(record);
    } catch (error) {
      await bridge?.close();
      if (writes) input.delete(target.conversation.id);
      throw error;
    }
  }
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://dura"),
      path = url.pathname;
    if (closing) throw new HttpError(503, "Runtime is closing");
    if (request.method === "GET" && path === "/v1/status") {
      reply(response, orchestrator ? 200 : 503, { version: 1, ready: !!orchestrator, pid: process.pid });
      return;
    }
    if (!orchestrator) throw new HttpError(503, "Runtime is opening its durable storage");
    if (request.method === "GET" && path === "/v1/runs") {
      reply(response, 200, await orchestrator.list());
      return;
    }
    if (request.method === "POST" && path === "/v1/runs") {
      const body = await readBody(request),
        id = commandId(body);
      const { id: _id, catalogFile, ...start } = body;
      if (catalogFile !== undefined && (typeof catalogFile !== "string" || !catalogFile.startsWith("/")))
        throw new Error("Catalog must be an absolute JSON file path");
      reply(
        response,
        200,
        await orchestrator.start(start as unknown as StartRunInput, id, catalogFile as string | undefined),
      );
      return;
    }
    const stream = /^\/v1\/runs\/([^/]+)\/conversations\/([^/]+)$/.exec(path);
    if (request.method === "GET" && stream) {
      await conversation(
        request,
        response,
        decodeURIComponent(stream[1] as string),
        decodeURIComponent(stream[2] as string),
        url.searchParams.get("control") === "1",
      );
      return;
    }
    const command = /^\/v1\/conversations\/([^/]+)\/commands$/.exec(path);
    if (request.method === "POST" && command) {
      const attached = attachments.get(decodeURIComponent(command[1] as string));
      if (!attached) throw new HttpError(410, "Conversation view detached; reconnect");
      const body = await readBody(request),
        native = body.command as ConversationCommand;
      if (attachments.get(attached.id) !== attached)
        throw new HttpError(410, "Conversation view detached; reconnect");
      if (!native || typeof native !== "object" || typeof native.type !== "string")
        throw new Error("A conversation command is required");
      if (!READ.has(native.type)) {
        const current = await orchestrator.conversation(attached.runId, attached.taskId);
        if (
          !attached.control ||
          !current.canWrite ||
          current.identity.attemptId !== attached.attemptId ||
          current.conversation.id !== attached.conversationId
        )
          throw new HttpError(409, "This view no longer has input authority");
      }
      if (attachments.get(attached.id) !== attached)
        throw new HttpError(410, "Conversation view detached; reconnect");
      const operation = attached.bridge.call(
        native.type === "get_snapshot" ? native : { ...native, id: commandId(body) },
      );
      attached.active.add(operation);
      try {
        reply(response, 200, await operation);
      } finally {
        attached.active.delete(operation);
      }
      return;
    }
    const entity = /^\/v1\/(questions|tasks)\/([^/]+)\/(answer|retry|revise|integrate)$/.exec(path);
    if (request.method === "POST" && entity) {
      const body = await readBody(request),
        id = commandId(body),
        target = decodeURIComponent(entity[2] as string),
        operation = entity[3];
      let result: unknown;
      if (entity[1] === "questions" && operation === "answer") {
        if (typeof body.answer !== "string") throw new Error("Answer must be text");
        result = await orchestrator.answer(target, body.answer, id);
      } else if (entity[1] === "tasks" && ["retry", "revise", "integrate"].includes(operation as string)) {
        if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1)
          throw new Error("Current task revision is required");
        if (operation === "revise") {
          if (!body.input || typeof body.input !== "object" || Array.isArray(body.input))
            throw new Error("Revision input is required");
          result = await orchestrator.revise(
            target,
            Number(body.revision),
            body.input as ReviseTaskInput,
            id,
          );
        } else
          result = await orchestrator[operation as "retry" | "integrate"](target, Number(body.revision), id);
      } else throw new HttpError(404, "No such runtime endpoint");
      reply(response, 200, result);
      return;
    }
    const run = /^\/v1\/runs\/([^/]+)(?:\/(stop|recover|apply))?$/.exec(path);
    if (run) {
      const name = decodeURIComponent(run[1] as string),
        operation = run[2];
      if (request.method === "GET" && !operation) {
        reply(response, 200, await orchestrator.inspect(name));
        return;
      }
      if (request.method === "POST" && operation) {
        const body = await readBody(request),
          id = commandId(body);
        reply(
          response,
          200,
          operation === "stop"
            ? await orchestrator.stop(name, id)
            : operation === "recover"
              ? await orchestrator.recover(name, id)
              : await orchestrator.apply(name, id),
        );
        return;
      }
    }
    throw new HttpError(404, "No such runtime endpoint");
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      shutdown.abort();
      unwatchAuthority();
      const stopped = new Promise<void>((done) => server.close(() => done()));
      await Promise.allSettled([...routes]);
      await Promise.allSettled([...attachments.keys()].map(closeAttachment));
      await Promise.allSettled([...detachments]);
      try {
        await orchestrator?.close();
      } finally {
        server.closeAllConnections();
        await stopped;
      }
    })();
    return closePromise;
  };
  try {
    try {
      const existing = lstatSync(socket);
      if (!existing.isSocket() || existing.uid !== process.getuid?.())
        throw new Error("Runtime socket is occupied");
      const live = await new Promise<boolean>((done) => {
        const client = connectSocket(socket);
        client.once("connect", () => {
          client.destroy();
          done(true);
        });
        client.once("error", () => done(false));
        client.setTimeout(1000, () => {
          client.destroy();
          done(true);
        });
      });
      if (live) throw new Error("A runtime already owns this state directory");
      if (lstatSync(socket).ino === existing.ino) rmSync(socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(socket, done);
    });
    chmodSync(socket, 0o600);
    const environment = { ...process.env, ...options.environment };
    orchestrator = await Orchestrator.open({
      root,
      catalog: options.catalog,
      catalogFile: options.catalogFile ?? environment.DURA_CATALOG,
      limits:
        options.limits ??
        (environment.DURA_RUN_LIMITS ? JSON.parse(environment.DURA_RUN_LIMITS) : undefined),
      environment,
      models: options.models,
    });
    unwatchAuthority = orchestrator.harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type !== "document" || change.record.kind !== DomainDoc.definition.kind || !change.value)
          continue;
        const detail = change.value.detail as unknown as RunDetail | null;
        if (!detail) continue;
        for (const attached of attachments.values()) {
          if (attached.archived || attached.runId !== detail.run.id) continue;
          const task = detail.tasks.find((item) => item.id === attached.taskId),
            attempt = detail.attempts.find((item) => item.id === task?.currentAttemptId);
          if (
            detail.run.desired === "running" &&
            task &&
            ["queued", "running", "waiting"].includes(task.status) &&
            attempt?.desired === "running" &&
            attempt.id === attached.attemptId
          )
            continue;
          attached.response.write(
            `${JSON.stringify({ type: "closed", reason: "This task changed; reconnect to its current conversation" })}\n`,
          );
          void closeAttachment(attached.id);
        }
      }
    });
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function serveRuntime(options: SupervisorOptions): Promise<void> {
  const runtime = await startRuntime(options);
  await new Promise<void>((done, reject) => {
    const stop = () => {
      for (const signal of signals) EventEmitter.prototype.removeListener.call(process, signal, stop);
      void runtime.close().then(done, reject);
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.once(signal, stop);
  });
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value ?? null));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024 * 1024) throw new HttpError(413, "Runtime request exceeds 16 MiB");
    chunks.push(bytes);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as Record<string, unknown>;
}
function commandId(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || !body.id || body.id.length > 256)
    throw new Error("A stable command ID is required");
  return body.id;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  let stateDirectory = process.env.DURA_STATE_DIR,
    catalogFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index],
      value = args[++index];
    if (!value) throw new Error("Missing runtime argument");
    if (flag === "--state") stateDirectory = value;
    else if (flag === "--catalog") catalogFile = value;
    else throw new Error(`Unknown runtime argument ${flag}`);
  }
  if (!stateDirectory) throw new Error("Runtime state directory is required");
  await serveRuntime({ stateDirectory, catalogFile });
}
