import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { assertBaySession, Bay, BayError, type BayMessage } from "./bay.ts";
import { type AgentCatalog, loadCatalog } from "./catalog.ts";
import { type DomainRequest, domainRequestId, validateDelivery } from "./domain-protocol.ts";
import { Engine, type StartRunInput } from "./engine.ts";
import {
  assignmentFor,
  ExecutionChanged,
  type ExecutionContext,
  ExecutionFailed,
  Executor,
} from "./executor.ts";
import { archiveWorker, projectArchive, projectWorker, readArchive } from "./projection.ts";
import { runtimeSocket } from "./runtime.ts";
import { type Attempt, type Effect, type RunLimits, RunStore } from "./store.ts";
import type { WorkerClient } from "./worker-client.ts";

export interface SupervisorOptions {
  stateDirectory: string;
  catalog?: AgentCatalog;
  catalogFile?: string;
  bayCommand?: string;
  workerCommand?: readonly string[];
  workerEnvironment?: NodeJS.ProcessEnv;
  startupTimeout?: number;
  limits?: Partial<RunLimits>;
}
export interface RuntimeHandle {
  close(): Promise<void>;
}
type Projection = Awaited<ReturnType<typeof projectWorker>>;
interface Connection {
  client: WorkerClient;
  context: ExecutionContext;
  projection?: Projection;
  unsubscribe: Array<() => void>;
  closing: boolean;
  teardown?: Promise<void>;
}
interface MailReference {
  socket: string;
  attemptId: string;
  fromId: string;
  thread: number;
}

/** One local writer. Decisions commit before I/O; native conversations stay with their workers. */
export async function startRuntime(options: SupervisorOptions): Promise<RuntimeHandle> {
  const environment = { ...process.env, ...options.workerEnvironment };
  const workerCommand =
    options.workerCommand ?? jsonEnvironment<readonly string[]>(environment.PITUITARY_WORKER_COMMAND);
  const startupTimeout = options.startupTimeout ?? Number(environment.PITUITARY_STARTUP_TIMEOUT ?? 15_000);
  const executor = new Executor(workerCommand, startupTimeout, environment);
  const catalogFile = options.catalogFile ?? environment.PITUITARY_CATALOG;
  const fixedCatalog = options.catalog ?? jsonEnvironment<AgentCatalog>(environment.PITUITARY_SOURCE_CATALOG);
  const catalog = fixedCatalog;
  const store = new RunStore(resolve(options.stateDirectory));
  const engine = new Engine(store, {
    catalog,
    bayCommand: options.bayCommand ?? environment.PITUITARY_BAY_COMMAND,
    limits: options.limits ?? jsonEnvironment<Partial<RunLimits>>(environment.PITUITARY_RUN_LIMITS),
  });
  const owner = { pid: process.pid, process: processIdentity(process.pid), nonce: randomUUID() };
  try {
    store.transaction(() => {
      const previous = jsonEnvironment<typeof owner>(store.getCursor("runtime-owner") ?? undefined);
      if (previous && processAlive(previous.pid, previous.process))
        throw new Error("A runtime already owns this state directory");
      store.setCursor("runtime-owner", JSON.stringify(owner));
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const socket = runtimeSocket(store.root);
  const connections = new Map<string, Connection>();
  const teardowns = new Map<string, Promise<void>>();
  const archives = new Map<string, Projection>();
  const archiveJobs = new Map<string, Promise<Projection | null>>();
  const jobs = new Map<string, { attemptId: string; kind: Effect["kind"] }>();
  const feedErrors = new Map<string, string>();
  let closing = false;
  let reconciling = false;
  let feeding = false;
  let closePromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let mailTimer: ReturnType<typeof setInterval> | undefined;

  const contextFor = (id: string): ExecutionContext => {
    const attempt = store.getAttempt(id),
      task = store.getTask(attempt.taskId),
      run = store.getRun(task.runId);
    return { attempt, task, run };
  };
  const writable = (id: string): boolean => {
    if (closing) return false;
    const { attempt, task, run } = contextFor(id);
    return (
      attempt.desired === "running" &&
      run.desired === "running" &&
      !["submitted", "failed", "cancelled"].includes(task.status)
    );
  };
  const discard = (connection: Connection): Promise<void> => {
    if (connection.teardown) return connection.teardown;
    const id = connection.context.attempt.id;
    connection.closing = true;
    if (connections.get(id) === connection) connections.delete(id);
    for (const off of connection.unsubscribe) off();
    const teardown = (async () => {
      await connection.projection?.close();
      await connection.client.close();
    })();
    connection.teardown = teardown;
    teardowns.set(id, teardown);
    void teardown
      .finally(() => {
        if (teardowns.get(id) === teardown) teardowns.delete(id);
      })
      .catch(() => {});
    return teardown;
  };
  const archiveProjection = async (attempt: Attempt): Promise<Projection | null> => {
    const existing = archives.get(attempt.id);
    if (existing) return existing;
    let pending = archiveJobs.get(attempt.id);
    if (!pending) {
      pending = (async () => {
        const archive = readArchive(attempt.directory);
        if (!archive) return null;
        const projection = await projectArchive(attempt.socket, archive);
        if (closing) {
          await projection.close();
          return null;
        }
        archives.set(attempt.id, projection);
        return projection;
      })();
      archiveJobs.set(attempt.id, pending);
      void pending.finally(() => archiveJobs.delete(attempt.id)).catch(() => {});
    }
    return pending;
  };

  async function domain(connection: Connection, request: DomainRequest): Promise<void> {
    if (closing || connection.closing) return;
    const assignment = assignmentFor(connection.context);
    try {
      if (request.id !== domainRequestId(assignment, request.assistantEntryId, request.toolCallId))
        throw new Error("Domain request does not match its native tool call");
      // A receipt can be replayed after cancellation. New commands need the current host grant
      // and Bay generation, which cannot be rewound by a guest memory snapshot.
      const cached = store.receipt(`${assignment.attemptId}:${assignment.epoch}`, request.id);
      if (!cached) {
        const execution = contextFor(assignment.attemptId).attempt.execution;
        if (execution.kind === "bay") {
          const session = await new Bay(execution.socket, execution.command, environment).get(
            execution.sessionName,
          );
          if (closing || connection.closing) return;
          try {
            assertBaySession(session, {
              name: execution.sessionName,
              id: execution.recordId,
              generation: execution.generation,
              agent: execution.agent,
            });
            if (session.state !== "running") throw new Error("Bay execution is no longer running");
          } catch (error) {
            engine.interruptAttempt(assignment.attemptId, message(error));
            throw error;
          }
        }
      }
      if (closing || connection.closing) return;
      const data = engine.command(assignment, request.id, request.command);
      connection.client.answerDomain({ type: "domain_result", id: request.id, success: true, data });
    } catch (error) {
      connection.client.answerDomain({
        type: "domain_result",
        id: request.id,
        success: false,
        error: message(error),
      });
    }
    kick();
  }

  async function register(client: WorkerClient, context: ExecutionContext): Promise<void> {
    if (closing) {
      void client.close();
      throw new Error("Runtime is closing");
    }
    const previous = connections.get(context.attempt.id);
    if (previous) await discard(previous);
    await teardowns.get(context.attempt.id);
    if (closing) {
      await client.close();
      throw new Error("Runtime is closing");
    }
    const connection: Connection = { client, context, unsubscribe: [], closing: false };
    connections.set(context.attempt.id, connection);
    // Register before initialize: native history recovery can request an already committed receipt.
    connection.unsubscribe.push(
      client.onDomainRequest((request) => {
        void domain(connection, request);
      }),
    );
    connection.unsubscribe.push(
      client.onEvent((event) => {
        if (closing || connection.closing) return;
        if (event.type === "agent_start")
          engine.observeAttempt(context.attempt.id, { status: "busy" }, "worker_busy");
        else if (event.type === "agent_settled") {
          const current = contextFor(context.attempt.id);
          engine.observeAttempt(
            context.attempt.id,
            { status: current.task.status === "waiting" ? "waiting" : "ready" },
            "worker_settled",
          );
          kick();
        }
      }),
    );
    connection.unsubscribe.push(
      client.onClose((reason) => {
        if (closing || connection.closing) return;
        void discard(connection);
        engine.observeAttempt(
          context.attempt.id,
          { status: "unreachable", error: reason },
          "worker_disconnected",
        );
        kick();
      }),
    );
  }

  async function perform(effect: Effect): Promise<void> {
    const context = contextFor(effect.attemptId);
    try {
      if (effect.kind === "launch" || effect.kind === "reconnect") {
        const connected = await executor[effect.kind](context, {
          onCreated: (execution, pid) => {
            if (!closing) engine.recordExecution(effect.attemptId, execution, pid);
          },
          onClient: register,
        });
        if (closing) {
          await connected.client.close();
          return;
        }
        engine.ackEffect(effect.id, connected.outcome);
        const connection = connections.get(effect.attemptId);
        if (connection && !connection.closing) {
          connection.context = contextFor(effect.attemptId);
          // Keep the assignment epoch captured at connection establishment. Cancellation never
          // grants an old worker the newer epoch merely by updating a projection.
          connection.context = {
            ...connection.context,
            attempt: { ...connection.context.attempt, epoch: context.attempt.epoch },
          };
          const projection = await projectWorker(context.attempt.socket, connected.client, {
            canWrite: () => writable(effect.attemptId),
          });
          if (closing || connection.closing) await projection.close();
          else connection.projection = projection;
        }
      } else if (effect.kind === "stop") {
        const connection = connections.get(effect.attemptId);
        // Capture the native view before suspending the guest. Reports remain independently
        // inspectable even if an old engine cannot provide an atomic transcript snapshot.
        if (connection?.client.getSnapshot) {
          try {
            await archiveWorker(context.attempt.directory, connection.client);
          } catch (error) {
            if (!closing)
              store.append(
                context.run.id,
                "transcript_archive_unavailable",
                { error: message(error) },
                context.task.id,
                context.attempt.id,
              );
          }
        }
        if (closing) return;
        if (connection) {
          connection.closing = true;
          for (const off of connection.unsubscribe) off();
        }
        try {
          if (effect.payload.unstarted !== true) await executor.stop(context, connection?.client);
        } finally {
          if (connection) await discard(connection);
        }
        if (closing) return;
        engine.ackEffect(effect.id);
      } else if (effect.kind === "send") {
        const execution = context.attempt.execution;
        if (execution.kind !== "bay" || !execution.recordId || execution.generation === null)
          throw new Error("Task has no authenticated Bay mailbox");
        type Routing = Parameters<Bay["send"]>[1];
        let routing = effect.payload.routing as Routing | undefined;
        if (!routing) {
          const targetId = effect.payload.toTaskId;
          const target =
            typeof targetId === "string" ? contextFor(store.getTask(targetId).currentAttemptId) : null;
          if (target && target.attempt.execution.kind !== "bay")
            throw new Error("Recipient has no Bay mailbox");
          const targetExecution = target?.attempt.execution;
          if (targetExecution?.kind === "bay" && !targetExecution.recordId) {
            engine.deferEffect(effect.id, "Waiting for recipient mailbox");
            return;
          }
          const replyTo = effect.payload.replyTo;
          const reference =
            typeof replyTo === "string"
              ? jsonEnvironment<MailReference>(store.getCursor("mail:" + replyTo) ?? undefined)
              : undefined;
          if (
            replyTo !== undefined &&
            (!reference ||
              reference.socket !== execution.socket ||
              reference.attemptId !== context.attempt.id ||
              (targetExecution?.kind === "bay"
                ? targetExecution.recordId !== reference.fromId
                : reference.fromId !== "operator"))
          )
            throw new Error("Reply must name an inbox message from this recipient");
          routing = {
            id: execution.recordId,
            generation: execution.generation,
            to: targetExecution?.kind === "bay" ? targetExecution.sessionName : "operator",
            ...(targetExecution?.kind === "bay" ? { toId: targetExecution.recordId as string } : {}),
            clientId: effect.id,
            body: effect.payload.body as string,
            ...(reference ? { thread: reference.thread } : {}),
          };
          // Bind the concrete recipient once. A retry must replay the same receipt even if a
          // collaborator later gets a new attempt or its Bay name is reused.
          store.putEffect({ ...store.getEffect(effect.id), payload: { ...effect.payload, routing } });
        }
        await new Bay(execution.socket, execution.command, environment).send(execution.sessionName, routing);
        if (!closing) engine.ackEffect(effect.id);
      } else {
        const connection = connections.get(effect.attemptId);
        if (!connection || connection.closing) {
          engine.deferEffect(effect.id, "Waiting for worker connection");
          return;
        }
        if (effect.kind === "deliver") {
          const delivery = validateDelivery(
            effect.payload as unknown as Parameters<typeof validateDelivery>[0],
          );
          // Idle-only delivery prevents retries from creating extra native user turns.
          const state = await connection.client.getState();
          if (closing) return;
          if (state.isStreaming) {
            engine.deferEffect(effect.id, "Waiting for the current turn to settle");
            return;
          }
          await connection.client.request(delivery, effect.id);
        } else
          await connection.client.request(
            { type: "prompt", message: effect.payload.message as string },
            effect.id,
          );
        if (!closing) engine.ackEffect(effect.id);
      }
    } catch (error) {
      if (closing) return;
      if (error instanceof ExecutionChanged && effect.kind !== "stop") {
        engine.interruptAttempt(effect.attemptId, message(error));
        engine.ackEffect(effect.id);
      } else if (error instanceof ExecutionFailed)
        engine.failEffect(effect.id, message(error), { terminal: true });
      else if (effect.kind === "launch" && error instanceof BayError && error.code === "launch_rejected")
        engine.failEffect(effect.id, message(error), { terminal: true });
      else if (effect.kind === "launch" && error instanceof BayError && error.code === "capacity_exhausted")
        engine.deferEffect(effect.id, "Waiting for Bay machine capacity", 1000);
      else if (effect.kind === "deliver" && /busy|settle|streaming/i.test(message(error)))
        engine.deferEffect(effect.id, message(error));
      else
        engine.failEffect(effect.id, message(error), {
          retryable: ["launch", "reconnect", "send", "deliver", "stop"].includes(effect.kind),
        });
    } finally {
      jobs.delete(effect.id);
      kick();
    }
  }

  function kick(): void {
    if (closing || reconciling) return;
    reconciling = true;
    try {
      // Stops retain capacity even when every model turn is still running.
      for (let count = 0; count < 16 && jobs.size < 8; count++) {
        const effect = engine.claimEffect();
        if (!effect) break;
        const ordinary = [...jobs.values()].filter((item) => item.kind !== "stop");
        if (
          effect.kind !== "stop" &&
          (ordinary.length >= 4 || [...jobs.values()].some((item) => item.attemptId === effect.attemptId))
        ) {
          engine.deferEffect(effect.id, "Waiting for runtime dispatch capacity", 50);
          continue;
        }
        jobs.set(effect.id, { attemptId: effect.attemptId, kind: effect.kind });
        void perform(effect);
      }
    } finally {
      reconciling = false;
    }
  }

  function inbox(message: BayMessage, attempt: Attempt, source: ExecutionContext | undefined): void {
    const recipientTask = store.getTask(attempt.taskId);
    const sourceIsCurrent =
      source?.run.id === recipientTask.runId &&
      source?.attempt.execution.kind === "bay" &&
      source.task.currentAttemptId === source.attempt.id &&
      source.run.desired === "running" &&
      source.attempt.desired === "running" &&
      !["submitted", "failed", "cancelled"].includes(source.task.status) &&
      source.attempt.execution.recordId === message.fromId &&
      source.attempt.execution.generation === message.fromGeneration;
    const path = attempt.execution.kind === "bay" ? attempt.execution.socket : "";
    const id = `mail-${createHash("sha256")
      .update(JSON.stringify([path, message.fromId, message.toId, message.id]))
      .digest("hex")}`;
    store.setCursor(
      "mail:" + id,
      JSON.stringify({
        socket: path,
        attemptId: attempt.id,
        fromId: message.fromId,
        thread: message.thread,
      } satisfies MailReference),
    );
    const rootKey = "mail-root:" + path + ":" + message.thread;
    const previous = store.getCursor(rootKey);
    if (!previous) store.setCursor(rootKey, id);
    const attribution =
      source && !sourceIsCurrent
        ? `Message from an inactive or previous execution of ${message.from}; context only.`
        : !sourceIsCurrent
          ? `Bay message from ${message.from} (record ${message.fromId}, generation ${message.fromGeneration}); context only.`
          : "";
    let body = attribution ? `[${attribution}]\n\n${message.body}` : message.body;
    if (Buffer.byteLength(body) > 64 * 1024)
      body =
        Buffer.from(body)
          .subarray(0, 63 * 1024)
          .toString("utf8") + "\n[Message truncated to the inbox byte limit.]";
    engine.deliver(
      attempt.id,
      [
        {
          id,
          from: sourceIsCurrent ? source.task.id : message.from === "operator" ? "operator" : "bay",
          ...(sourceIsCurrent ? { taskId: source.task.id } : {}),
          body,
          ...(previous ? { replyTo: previous } : {}),
        },
      ],
      id,
    );
  }

  async function feed(): Promise<void> {
    if (closing || feeding) return;
    feeding = true;
    try {
      const sockets = new Map<string, string>();
      for (const attempt of store.listAttempts())
        if (attempt.grant.orchestration && attempt.execution.kind === "bay")
          sockets.set(attempt.execution.socket, attempt.execution.command);
      await Promise.allSettled(
        [...sockets].map(async ([path, command]) => {
          try {
            const key = "bay-feed:" + path;
            for (let pageNumber = 0; pageNumber < 8 && !closing; pageNumber++) {
              const page = await new Bay(path, command, environment).feed(store.getCursor(key) ?? undefined);
              if (closing) return;
              store.transaction(() => {
                const contexts = store.listAttempts().map((attempt) => contextFor(attempt.id));
                for (const message of page.messages) {
                  const recipient = contexts.find(
                    (item) =>
                      item.attempt.grant.orchestration &&
                      item.attempt.execution.kind === "bay" &&
                      item.attempt.execution.socket === path &&
                      item.attempt.execution.recordId === message.toId,
                  );
                  if (!recipient) continue;
                  const source = contexts.find(
                    (item) =>
                      item.attempt.execution.kind === "bay" &&
                      item.attempt.execution.socket === path &&
                      item.attempt.execution.recordId === message.fromId,
                  );
                  inbox(message, recipient.attempt, source);
                }
                store.setCursor(key, page.next);
              });
              if (!page.more) break;
            }
            if (feedErrors.delete(path))
              for (const run of store.listRuns())
                if (run.catalog?.baySocket === path) store.append(run.id, "mail_feed_recovered");
          } catch (error) {
            if (closing) return;
            const detail = message(error);
            if (feedErrors.get(path) !== detail) {
              feedErrors.set(path, detail);
              for (const run of store.listRuns())
                if (run.catalog?.baySocket === path)
                  store.append(run.id, "mail_feed_unavailable", { error: detail });
            }
          }
        }),
      );
    } finally {
      feeding = false;
      kick();
    }
  }

  async function attach(name: string, taskId?: string): Promise<{ socket: string }> {
    const run = store.getRun(name),
      task = store.getTask(taskId ?? run.rootTaskId);
    if (task.runId !== run.id) throw new Error("Task belongs to another run");
    const deadline = Date.now() + 225_000;
    while (!closing && Date.now() < deadline) {
      const attempt = store.getAttempt(store.getTask(task.id).currentAttemptId);
      if (connections.get(attempt.id)?.projection) return { socket: attempt.socket };
      if (["stopped", "failed", "interrupted"].includes(attempt.status)) {
        if (await archiveProjection(attempt)) return { socket: attempt.socket };
        throw new Error(attempt.error ?? "This attempt has no live conversation or archived transcript");
      }
      if (
        attempt.status === "unreachable" &&
        attempt.error &&
        !store
          .listEffects(run.id)
          .some(
            (effect) =>
              effect.attemptId === attempt.id &&
              ["launch", "reconnect"].includes(effect.kind) &&
              ["pending", "dispatching"].includes(effect.state),
          )
      )
        throw new Error(attempt.error + "; use pituitary recover after restoring its connection");
      await delay(25);
    }
    throw new Error(
      closing
        ? "Runtime is closing"
        : "Worker is still starting; its saved intent remains available through pituitary inspect",
    );
  }

  const server = createServer((request, response) => {
    void route(request, response).catch((error) => {
      if (!response.headersSent)
        reply(response, error instanceof HttpError ? error.status : 400, { error: message(error) });
      else response.destroy();
    });
  });
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) throw new HttpError(503, "Runtime is closing");
    const path = new URL(request.url ?? "/", "http://runtime").pathname;
    if (request.method === "GET" && path === "/v1/status") {
      reply(response, 200, { version: 1, pid: process.pid, root: store.root });
      return;
    }
    if (request.method === "GET" && path === "/v1/runs") {
      reply(response, 200, store.listRuns());
      return;
    }
    if (request.method === "POST" && path === "/v1/runs") {
      const body = await readBody(request),
        id = commandId(body),
        input = startInput(body);
      if (closing) throw new HttpError(503, "Runtime is closing");
      if (
        body.catalogFile !== undefined &&
        (typeof body.catalogFile !== "string" || !body.catalogFile.startsWith("/"))
      )
        throw new Error("Catalog must be an absolute JSON file path");
      const source =
        !input.agent || store.receipt("operator", id)
          ? undefined
          : body.catalogFile
            ? loadCatalog(body.catalogFile as string)
            : (fixedCatalog ?? (catalogFile ? loadCatalog(catalogFile) : catalog));
      const run = engine.start(input, id, source);
      reply(response, 200, run);
      kick();
      return;
    }
    const match = /^\/v1\/runs\/([^/]+)(?:\/(stop|recover|attach))?$/.exec(path);
    if (!match) throw new HttpError(404, "No such runtime endpoint");
    const name = decodeURIComponent(match[1] as string),
      operation = match[2];
    if (request.method === "GET" && !operation) {
      reply(response, 200, store.detail(name));
      return;
    }
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    const body = await readBody(request);
    if (closing) throw new HttpError(503, "Runtime is closing");
    if (operation === "attach") {
      if (body.taskId !== undefined && typeof body.taskId !== "string")
        throw new Error("Task ID must be a string");
      reply(response, 200, await attach(name, body.taskId as string | undefined));
      return;
    }
    const id = commandId(body);
    if (operation === "stop") reply(response, 200, engine.stop(name, id));
    else if (operation === "recover") reply(response, 200, engine.recover(name, id));
    else throw new HttpError(404, "No such runtime endpoint");
    kick();
  }

  function release(): void {
    store.transaction(() => {
      const current = jsonEnvironment<typeof owner>(store.getCursor("runtime-owner") ?? undefined);
      if (current?.nonce === owner.nonce) store.setCursor("runtime-owner", "");
    });
  }
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      if (timer) clearInterval(timer);
      if (mailTimer) clearInterval(mailTimer);
      // Detach native transports. Workers retain the execution and resume their durable host
      // requests when the next daemon reconnects; shutdown is reserved for an explicit stop.
      await Promise.allSettled([...connections.values()].map(discard));
      await Promise.allSettled([...teardowns.values()]);
      await Promise.allSettled([...archives.values()].map((projection) => projection.close()));
      archives.clear();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(socket, { force: true });
      release();
      store.close();
    })();
    return closePromise;
  };
  try {
    try {
      const occupied = lstatSync(socket);
      if (!occupied.isSocket() || (process.getuid && occupied.uid !== process.getuid()))
        throw new Error("Runtime socket is occupied");
      rmSync(socket);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(socket, done);
    });
    chmodSync(socket, 0o600);
    engine.recoverEffects();
    timer = setInterval(kick, 100);
    mailTimer = setInterval(() => {
      void feed();
    }, 250);
    kick();
    void feed();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Foreground service entry point, also used by the CLI's lazy-started daemon. */
export async function serveRuntime(options: SupervisorOptions): Promise<void> {
  const runtime = await startRuntime(options);
  await new Promise<void>((done, reject) => {
    const stop = () => {
      // Bun's Process augmentation narrows removeListener to its memoryPressure overload.
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
    detail: string,
  ) {
    super(detail);
  }
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
function jsonEnvironment<T>(value: string | undefined): T | undefined {
  return value ? (JSON.parse(value) as T) : undefined;
}
function processIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + fields[19];
  } catch {
    return "";
  }
}
function processAlive(pid: number, identity: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  return !identity || processIdentity(pid) === identity;
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024) throw new HttpError(413, "Runtime request exceeds 1 MiB");
    chunks.push(bytes);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
  return body as Record<string, unknown>;
}
function commandId(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || !body.id || body.id.length > 256)
    throw new Error("A stable command ID is required");
  return body.id;
}
function startInput(body: Record<string, unknown>): StartRunInput {
  if (typeof body.cwd !== "string") throw new Error("Working directory is required");
  for (const field of ["name", "prompt", "agent"] as const)
    if (body[field] !== undefined && typeof body[field] !== "string")
      throw new Error(`${field} must be a string`);
  if (body.prompt && Buffer.byteLength(body.prompt as string) > 64 * 1024)
    throw new Error("Objective exceeds 64 KiB");
  if (
    body.repos !== undefined &&
    (!Array.isArray(body.repos) ||
      body.repos.length > 32 ||
      body.repos.some((item) => typeof item !== "string" || item.length > 4096))
  )
    throw new Error("Invalid repository inputs");
  return {
    cwd: body.cwd,
    ...(body.name === undefined ? {} : { name: body.name as string }),
    ...(body.prompt === undefined ? {} : { prompt: body.prompt as string }),
    ...(body.agent === undefined ? {} : { agent: body.agent as string }),
    ...(body.repos === undefined ? {} : { repos: body.repos as string[] }),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let stateDirectory = process.env.PITUITARY_STATE_DIR,
    catalogFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--state") stateDirectory = args[++index];
    else if (args[index] === "--catalog") catalogFile = args[++index];
    else throw new Error("Unknown runtime argument " + args[index]);
  }
  if (!stateDirectory) throw new Error("Runtime state directory is required");
  await serveRuntime({ stateDirectory, catalogFile });
}
