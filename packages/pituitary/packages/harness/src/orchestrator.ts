import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  CompactionTask,
  type Conversation,
  type ConversationId,
  type Cursor,
  configure,
  createRegistry,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  defineTool,
  type Extension,
  GenerationTask,
  Harness,
  type HookApi,
  hook,
  type JsonObject,
  type ReportInfo,
  type Storage,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type AgentManifest, canonical } from "./agent.ts";
import { assertBaySession, Bay, BayError } from "./bay.ts";
import { BayExecutionEnv } from "./bay-environment.ts";
import { type AgentCatalog, type AgentDefinition, loadCatalog, type VerificationPolicy } from "./catalog.ts";
import { codingExtension, codingTools } from "./coding.ts";
import { type CommandName, commandSchemas, type DomainCommand } from "./commands.ts";
import { baySessionName, nativeConversation, nativeTask } from "./identity.ts";
import {
  type Artifact,
  type Attempt,
  DEFAULT_RUN_LIMITS,
  type Integration,
  type Question,
  type Report,
  type ReviseTaskInput,
  type Run,
  type RunDetail,
  type RunLimits,
  type StartRunInput,
  type Task,
  type TaskDependency,
  type Verification,
} from "./model.ts";
import { loadModels } from "./models.ts";
import { privateDirectory } from "./paths.ts";
import { type VerificationCheckpoint, Verifier } from "./verification.ts";
import { Workspaces } from "./workspaces.ts";

export type { ReviseTaskInput, StartRunInput } from "./model.ts";
export interface ApplyIntent {
  runId: string;
  inputArtifactId: string;
  artifactId: string;
}
export interface OrchestratorOptions {
  root: string;
  catalog?: AgentCatalog;
  catalogFile?: string;
  limits?: Partial<RunLimits>;
  environment?: NodeJS.ProcessEnv;
  models?: Models;
  storage?: Storage;
}
export interface ConversationIdentity {
  runId: string;
  taskId: string;
  attemptId: string;
  cwd: string;
  local: boolean;
  archived: boolean;
  role?: string;
}

type DomainTask = Task & { origin: string };
type RunState = Omit<RunDetail, "tasks" | "events"> & { tasks: DomainTask[] };
interface DomainState {
  detail: RunState | null;
  integrationOwner: string | null;
  applyOwner: string | null;
}
/** Business state shares the Harness transaction with native task and conversation creation. */
export const DomainDoc = defineDoc<DomainState & JsonObject>({
  kind: "pituitary.domain",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ detail: null, integrationOwner: null, applyOwner: null }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 63,
});
const DirectoryDoc = defineDoc<{ namespace: string; runs: Record<string, string> }>({
  kind: "pituitary.directory",
  version: 1,
  scope: "session",
  initial: () => ({ namespace: randomUUID(), runs: {} }),
  checkpointWhen: () => true,
});
const BindingDoc = defineDoc<{ runId: string; taskId: string; attemptId: string }>({
  kind: "pituitary.binding",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runId: "", taskId: "", attemptId: "" }),
  checkpointWhen: () => true,
});
const Event = defineEntry<JsonObject>("pituitary.event");
type Scope = { detail: RunState; run: Run; task: DomainTask; attempt: Attempt };
type Operation =
  | { type: "start"; input: StartRunInput; catalogFile?: string }
  | { type: "stop"; name: string }
  | { type: "answer"; questionId: string; answer: string }
  | { type: "retry"; taskId: string; revision: number }
  | { type: "revise"; taskId: string; revision: number; input: ReviseTaskInput }
  | { type: "integrate"; taskId: string; revision: number }
  | { type: "apply"; name: string }
  | { type: "recover"; name: string };
type OperatorInput = { operationId: string; operation: Operation };
type OperatorState =
  | { phase: "decide" }
  | { phase: "abort"; attempts: string[]; result: JsonValue }
  | { phase: "apply"; intent: ApplyIntent }
  | { phase: "recover"; runId: string }
  | { phase: "finish"; result: JsonValue };
type AgentInput = { runId: string };
type AgentState =
  | { phase: "capture" }
  | { phase: "provision"; dispatched: boolean }
  | { phase: "materialize" }
  | { phase: "start" }
  | { phase: "await_result" }
  | { phase: "export" }
  | { phase: "finish" };
type ResultInput = { runId: string; id: string };
type VerifyState = { phase: "run"; journal: VerificationCheckpoint };
type DeliveryInput = {
  runId: string;
  toTaskId: string;
  toAttemptId: string;
  fromTaskId: string | null;
  body: string;
  replyTo?: string;
  origin?: string;
};
const C = BACKGROUND_CONTEXT;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const closed = (task: Task) => !["queued", "running", "waiting"].includes(task.status);
const draft = async (tx: Tx, runId: string): Promise<DomainState> =>
  (await tx.doc(DomainDoc, nativeConversation(runId))) as DomainState;
function locate(state: DomainState, name: string): RunState {
  const detail = state.detail;
  if (!detail || (detail.run.id !== name && detail.run.name !== name))
    throw new Error(`No run named ${name}`);
  return detail;
}
function scope(state: DomainState, attemptId: string): Scope {
  const detail = state.detail,
    attempt = detail?.attempts.find((item) => item.id === attemptId),
    task = detail?.tasks.find((item) => item.id === attempt?.taskId);
  if (!detail || !attempt || !task) throw new Error("Unknown attempt");
  return { detail, run: detail.run, task, attempt };
}
function taskScope(state: DomainState, taskId: string): Scope {
  const task = state.detail?.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("Unknown task");
  return scope(state, task.currentAttemptId);
}
function replace<T extends { id: string }>(items: T[], next: T): void {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) items.push(next);
  else items[index] = next;
}
function immutable<T extends { id: string }>(items: T[], next: T): void {
  const old = items.find((item) => item.id === next.id);
  if (old && canonical(old) !== canonical(next)) throw new Error("Immutable result identity changed");
  if (!old) items.push(next);
}
async function event(
  tx: Tx,
  run: Run,
  type: string,
  data: Record<string, JsonValue> = {},
  taskId: string | null = null,
  attemptId: string | null = null,
): Promise<void> {
  await tx.appendEntry(Event, nativeConversation(run.id), {
    data: { type, at: new Date().toISOString(), taskId, attemptId, ...data },
  });
}

/** One host Harness owns conversations, native tasks, and typed business documents. */
export class Orchestrator {
  readonly harness: Harness;
  readonly models: Models;
  private readonly workspaces: Workspaces;
  private readonly verifier: Verifier;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly authorizeModel: (manifest: AgentManifest) => void;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly environments = new Map<string, { conversationId: ConversationId; env: ExecutionEnv }>();
  private readonly agentJob;
  private readonly integrationJob;
  private readonly verificationJob;
  private readonly deliveryJob;
  private readonly operatorJob;
  private readonly deadlineJob;
  private readonly extension: Extension;
  private readonly tools: readonly ToolRegistration[];

  private constructor(
    harness: Harness,
    private readonly options: OrchestratorOptions,
    authorize: (manifest: AgentManifest) => void,
    models: Models,
    private readonly namespace: string,
  ) {
    this.harness = harness;
    this.models = models;
    this.environment = options.environment ?? process.env;
    this.authorizeModel = authorize;
    this.workspaces = new Workspaces(options.root, () => !this.closing);
    this.verifier = new Verifier(this.workspaces, namespace);
    this.agentJob = defineTask<AgentInput, AgentState, null>({
      name: "pituitary.agent",
      version: 1,
      initial: () => ({ phase: "capture" }),
      phases: {
        capture: (task, runtime, context) => this.capture(String(task.id), runtime, context),
        provision: (task, runtime, context) =>
          this.provision(String(task.id), task.state.checkpoint, runtime, context),
        materialize: (task, runtime, context) => this.materialize(String(task.id), runtime, context),
        start: (task, runtime, context) => this.begin(String(task.id), runtime, context),
        await_result: (task, runtime, context) => this.awaitResult(String(task.id), runtime, context),
        export: (task, runtime, context) => this.exportResult(String(task.id), runtime, context),
        finish: (task, runtime, context) => this.finishAgent(String(task.id), runtime, context),
      },
      abort: (task, runtime, context) => this.abortAgent(String(task.id), runtime, context),
    });
    this.integrationJob = defineTask<ResultInput, { phase: "integrate" }, null>({
      name: "pituitary.integrate",
      version: 1,
      initial: () => ({ phase: "integrate" }),
      phases: {
        integrate: (task, runtime, context) =>
          this.integrateResult(task.input, String(task.id), runtime, context),
      },
      abort: (task, runtime, context) => this.abortIntegration(task.input, String(task.id), runtime, context),
    });
    this.verificationJob = defineTask<ResultInput, VerifyState, null>({
      name: "pituitary.verify",
      version: 1,
      initial: () => ({ phase: "run", journal: {} }),
      phases: {
        run: (task, runtime, context) =>
          this.verifyResult(task.input, String(task.id), task.state.checkpoint.journal, runtime, context),
      },
      abort: (task, runtime, context) =>
        this.abortVerification(task.input, runtime, context, task.state.checkpoint.journal),
    });
    this.deliveryJob = defineTask<DeliveryInput, { phase: "deliver" }, null>({
      name: "pituitary.deliver",
      version: 1,
      initial: () => ({ phase: "deliver" }),
      phases: {
        deliver: async (task, runtime, context) => {
          const current = await this.waitFor(
            task.input.runId,
            (state) => {
              const target = taskScope(state, task.input.toTaskId);
              return (
                target.attempt.id !== task.input.toAttemptId ||
                target.attempt.conversationId ||
                target.run.desired === "stopped" ||
                closed(target.task)
              );
            },
            runtime.signal,
            context,
          );
          const target = taskScope(current, task.input.toTaskId);
          if (target.run.id !== task.input.runId) throw new Error("Message crossed run boundary");
          if (
            target.attempt.id === task.input.toAttemptId &&
            target.attempt.conversationId &&
            target.attempt.desired === "running" &&
            !closed(target.task)
          ) {
            const conversation = await runtime.conversation(
              nativeConversation(target.attempt.conversationId),
              context,
            );
            if (!conversation) throw new Error("Missing target conversation");
            await conversation.submit(
              {
                type: "input",
                requestId: String(task.id),
                whenBusy: "followUp",
                content: `[Message ${task.id} from ${task.input.fromTaskId ?? "operator"}${task.input.replyTo ? `, reply to ${task.input.replyTo}` : ""}]\n${task.input.body}`,
                entry: {
                  kind: "pituitary.message",
                  data: {
                    messageId: String(task.id),
                    fromTaskId: task.input.fromTaskId,
                    replyTo: task.input.replyTo ?? null,
                  },
                },
              },
              context,
            );
          }
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
        },
      },
      abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
    });
    this.operatorJob = defineTask<OperatorInput, OperatorState, JsonValue>({
      name: "pituitary.operator",
      version: 1,
      initial: () => ({ phase: "decide" }),
      phases: {
        decide: (task, runtime, context) => this.decide(String(task.id), task.input, runtime, context),
        abort: async (task, runtime, context) => {
          for (const id of task.state.checkpoint.attempts) {
            await this.harness.abortTask(nativeTask(id), context);
            await this.harness.waitForTask(nativeTask(id), context);
            const native = await this.harness.getTask(nativeTask(id), context);
            if (native?.kind === this.agentJob.definition.name) {
              const input = native.input as unknown as AgentInput;
              await this.suspendAttempt(input.runId, id, context);
            }
          }
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: { phase: "finish", result: task.state.checkpoint.result },
            }),
            context,
          );
        },
        apply: async (task, runtime, context) => {
          const intent = task.state.checkpoint.intent,
            state = await this.state(intent.runId, context),
            detail = locate(state, intent.runId);
          if (
            detail.run.acceptedArtifactId !== intent.artifactId ||
            detail.run.integrationArtifactId !== intent.artifactId
          )
            throw new Error("Accepted result changed before apply");
          const input = detail.artifacts.find((item) => item.id === intent.inputArtifactId),
            accepted = detail.artifacts.find((item) => item.id === intent.artifactId);
          if (!input || !accepted) throw new Error("Accepted artifact bytes are unavailable");
          try {
            if (state.applyOwner !== String(task.id)) throw new Error("Apply ownership changed");
            const result = await this.workspaces.apply(detail.run, input, accepted);
            await runtime.commit(async (tx) => {
              const state = await draft(tx, intent.runId);
              if (state.applyOwner === String(task.id)) state.applyOwner = null;
              await event(tx, detail.run, "result_applied", {
                artifactId: result.artifactId,
                applied: result.applied,
              });
              return { status: "running", checkpoint: { phase: "finish", result } };
            }, context);
          } catch (error) {
            if (this.closing || runtime.signal.aborted) throw error;
            await runtime.commit(async (tx) => {
              const state = await draft(tx, intent.runId);
              if (state.applyOwner === String(task.id)) state.applyOwner = null;
              await event(tx, detail.run, "apply_failed", {
                artifactId: intent.artifactId,
                error: String(error),
              });
              return { status: "terminal", outcome: { status: "failed", error: { message: String(error) } } };
            }, context);
          }
        },
        recover: async (task, runtime, context) => {
          const state = await this.state(task.state.checkpoint.runId, context),
            detail = locate(state, task.state.checkpoint.runId);
          const ids = [
            ...detail.attempts.filter((item) => item.desired === "running").map((item) => item.id),
            ...detail.integrations.filter((item) => item.status === "pending").map((item) => item.id),
            ...detail.verifications
              .filter((item) => ["pending", "running"].includes(item.status))
              .map((item) => item.id),
          ];
          for (const id of ids) {
            const native = await this.harness.getTask(nativeTask(id), context);
            if (
              native &&
              native.state.status !== "terminal" &&
              native.state.status !== "completing" &&
              (native.restarts ?? 0) > 0
            )
              await this.harness.retryTask(nativeTask(id), context);
          }
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "finish", result: detail.run.id } }),
            context,
          );
        },
        finish: (task, runtime, context) =>
          runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: task.state.checkpoint.result },
            }),
            context,
          ),
      },
      abort: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          if (task.state.checkpoint.phase === "apply") {
            const state = await draft(tx, task.state.checkpoint.intent.runId);
            if (state.applyOwner === String(task.id)) state.applyOwner = null;
          }
          return { status: "terminal", outcome: { status: "aborted" } };
        }, context),
    });
    this.deadlineJob = defineTask<{ runId: string; at: number }, { phase: "wait" } | { phase: "stop" }, null>(
      {
        name: "pituitary.deadline",
        version: 1,
        initial: () => ({ phase: "wait" }),
        phases: {
          wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "stop" }, context),
          stop: async (task, runtime, context) => {
            await this.command({ type: "stop", name: task.input.runId }, String(task.id), context);
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              context,
            );
          },
        },
        abort: (_task, runtime, context) =>
          runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
      },
    );
    this.tools = this.makeTools();
    this.extension = defineExtension({
      name: "pituitary",
      tools: [...this.tools],
      tasks: [
        this.agentJob,
        this.integrationJob,
        this.verificationJob,
        this.deliveryJob,
        this.operatorJob,
        this.deadlineJob,
      ],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            await this.guardModelRequest(api, context);
          },
        }),
        hook(CompactionTask, {
          beforeCompact: async (_request, api, context) => {
            await this.guardModelRequest(api, context);
          },
        }),
      ],
    });
  }

  static async open(options: OrchestratorOptions): Promise<Orchestrator> {
    const root = resolve(options.root);
    privateDirectory(root);
    const path = join(root, "harness.sqlite");
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Harness database must not be a symlink");
    const hosted = options.models
      ? { models: options.models, authorize: (_manifest: AgentManifest) => {} }
      : loadModels(options.environment);
    let storage = options.storage;
    if (!storage) {
      const db = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0 });
      try {
        await db.exec("PRAGMA locking_mode=EXCLUSIVE");
        await db.exec("PRAGMA synchronous=FULL");
        storage = await SqliteStorage.open(db);
        chmodSync(path, 0o600);
      } catch (error) {
        await db.close();
        throw error;
      }
    }
    const registry = createRegistry();
    registry.install(codingExtension);
    let domain: Orchestrator | undefined;
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(
        storage,
        {
          models: hosted.models,
          registry,
          onReport: (error, info) => {
            if (domain) void domain.recordFailure(error, info).catch(() => {});
          },
          env: async (target, context) => {
            if (!domain) throw new Error("Orchestrator is opening");
            const owned = await domain.bound(target.conversationId, context);
            if (!owned) throw new Error("Conversation has no declared execution environment");
            domain.requireActive(owned);
            const cwd = target.cwd ?? owned.attempt.cwd,
              key = `${target.conversationId}:${cwd}`,
              cached = domain.environments.get(key);
            if (cached) return cached.env;
            const env = owned.attempt.execution
              ? new BayExecutionEnv(owned.attempt.execution, cwd)
              : new NodeExecutionEnv({ cwd });
            domain.environments.set(key, { conversationId: target.conversationId, env });
            return env;
          },
        },
        C,
      );
      const namespace = await harness.commit(async (tx) => (await tx.doc(DirectoryDoc)).namespace, C);
      domain = new Orchestrator(harness, { ...options, root }, hosted.authorize, hosted.models, namespace);
      registry.install(domain.extension);
      harness.resume();
      return domain;
    } catch (error) {
      if (domain) await domain.close().catch(() => {});
      else if (harness) await harness.close(C).catch(() => {});
      else await storage.close(C).catch(() => {});
      if (!options.storage) Bun.gc(true);
      throw error;
    }
  }

  async start(input: StartRunInput, id: string = randomUUID(), catalogFile?: string): Promise<Run> {
    const result = await this.command({ type: "start", input, ...(catalogFile ? { catalogFile } : {}) }, id);
    return (await this.inspect(String(result))).run;
  }
  async list(): Promise<Run[]> {
    const directory = await this.harness.snapshot(DirectoryDoc, C);
    return Promise.all(
      Object.values(directory?.runs ?? {}).map(async (id) => locate(await this.state(id), id).run),
    );
  }
  async inspect(name: string): Promise<RunDetail> {
    const id = await this.runId(name),
      detail = locate(await this.state(id), id),
      conversation = await this.harness.conversation(nativeConversation(id), C);
    const events: RunDetail["events"] = [];
    let cursor: Cursor | undefined;
    if (conversation)
      do {
        const page = await conversation.entries({ order: "ascending" }, 1000, cursor, C);
        for (const entry of page.items)
          if (entry.kind === Event.kind) {
            const data = entry.data as Record<string, JsonValue>;
            events.push({
              sequence: events.length + 1,
              runId: id,
              taskId: data.taskId as string | null,
              attemptId: data.attemptId as string | null,
              type: String(data.type),
              at: String(data.at),
              data,
            });
          }
        cursor = page.next;
      } while (cursor);
    return {
      ...detail,
      tasks: detail.tasks.map((task) => ({
        ...task,
        report: detail.reports.find((report) => report.id === task.reportId) ?? null,
      })),
      events,
    };
  }
  async stop(name: string, id: string = randomUUID()): Promise<Run> {
    await this.command({ type: "stop", name }, id);
    return (await this.inspect(name)).run;
  }
  async recover(name: string, id: string = randomUUID()): Promise<Run> {
    await this.command({ type: "recover", name }, id);
    return (await this.inspect(name)).run;
  }
  async answer(questionId: string, answer: string, id: string = randomUUID()): Promise<Question> {
    await this.command({ type: "answer", questionId, answer }, id);
    const runId = await this.operationRun({ type: "answer", questionId, answer });
    const question = locate(await this.state(runId!), runId!).questions.find(
      (item) => item.id === questionId,
    );
    if (!question) throw new Error("Question disappeared");
    return question;
  }
  async retry(taskId: string, revision: number, id: string = randomUUID()): Promise<Task> {
    await this.command({ type: "retry", taskId, revision }, id);
    return taskScope(await this.state(await this.taskRun(taskId)), taskId).task;
  }
  async revise(
    taskId: string,
    revision: number,
    input: ReviseTaskInput,
    id: string = randomUUID(),
  ): Promise<Task> {
    await this.command({ type: "revise", taskId, revision, input }, id);
    return taskScope(await this.state(await this.taskRun(taskId)), taskId).task;
  }
  async integrate(taskId: string, revision: number, id: string = randomUUID()): Promise<Integration> {
    const result = String(await this.command({ type: "integrate", taskId, revision }, id));
    const owned = taskScope(await this.state(await this.taskRun(taskId)), taskId);
    const item = owned.detail.integrations.find((item) => item.id === result);
    if (!item) throw new Error("Missing integration");
    return item;
  }
  async apply(name: string, id: string = randomUUID()): Promise<{ artifactId: string; applied: boolean }> {
    return (await this.command({ type: "apply", name }, id)) as unknown as {
      artifactId: string;
      applied: boolean;
    };
  }
  async waitConversation(
    name: string,
    taskId?: string,
    context: Context = C,
  ): Promise<{ conversation: Conversation; identity: ConversationIdentity; canWrite: boolean }> {
    const id = await this.runId(name, context),
      initial = locate(await this.state(id, context), id),
      selected = taskId ?? initial.run.rootTaskId;
    const controller = new AbortController(),
      abort = () => controller.abort(context.abortSignal?.reason);
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    if (context.abortSignal?.aborted) abort();
    try {
      await this.waitFor(
        id,
        (state) => {
          const owned = taskScope(state, selected);
          return (
            owned.attempt.conversationId ||
            owned.attempt.error ||
            owned.attempt.desired === "stopped" ||
            owned.run.desired === "stopped"
          );
        },
        controller.signal,
        context,
      );
      return this.conversation(name, selected);
    } finally {
      context.abortSignal?.removeEventListener("abort", abort);
    }
  }
  async conversation(
    name: string,
    taskId?: string,
  ): Promise<{ conversation: Conversation; identity: ConversationIdentity; canWrite: boolean }> {
    const id = await this.runId(name),
      state = await this.state(id),
      detail = locate(state, id),
      task = detail.tasks.find((item) => item.id === (taskId ?? detail.run.rootTaskId));
    if (!task) throw new Error("No such task in this run");
    const owned = scope(state, task.currentAttemptId);
    if (!owned.attempt.conversationId)
      throw new Error(owned.attempt.error ?? "Agent environment is still being prepared");
    const conversation = await this.harness.conversation(nativeConversation(owned.attempt.conversationId), C);
    if (!conversation) throw new Error("Conversation unavailable");
    const canWrite =
      owned.run.desired === "running" && owned.attempt.desired === "running" && !closed(owned.task);
    return {
      conversation,
      canWrite,
      identity: {
        runId: detail.run.id,
        taskId: task.id,
        attemptId: owned.attempt.id,
        cwd: owned.attempt.cwd,
        local: owned.task.role === null,
        archived: !canWrite,
        ...(task.role ? { role: task.role } : {}),
      },
    };
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true;
      const results = await Promise.allSettled([this.harness.close(C), this.closeEnvironments()]);
      // Bun's node:sqlite close retains prepared-statement file locks until finalization.
      // The native storage has joined and closed; collect those handles before reopening it.
      if (!this.options.storage) Bun.gc(true);
      await this.workspaces.close();
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    })();
    return this.closePromise;
  }
  private async closeEnvironments(conversationId?: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const [key, value] of this.environments)
      if (!conversationId || String(value.conversationId) === conversationId) {
        this.environments.delete(key);
        jobs.push(value.env.cleanup(C));
      }
    const results = await Promise.allSettled(jobs),
      failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  private async guardModelRequest(api: HookApi, context: Context): Promise<void> {
    const owned = await this.bound(api.conversationId, context);
    let allowed = Boolean(owned),
      reason: string | undefined;
    if (owned) {
      try {
        this.requireActive(owned);
      } catch {
        allowed = false;
      }
      if (allowed && owned.task.role) {
        const role = this.role(owned),
          conversation = await this.harness.conversation(api.conversationId, context),
          agent = await conversation?.agent(context),
          selected = agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : null;
        try {
          if (selected !== role.manifest.model) throw new Error("Declared agent model is immutable");
          this.authorizeModel(role.manifest);
        } catch (error) {
          allowed = false;
          reason = String(error);
        }
      }
    }
    if (!allowed) {
      if (reason && owned)
        await this.harness.commit(async (tx) => {
          const current = scope(await draft(tx, owned.run.id), owned.attempt.id);
          if (current.attempt.desired === "running") {
            replace(current.detail.attempts, { ...current.attempt, error: reason! });
            await event(
              tx,
              current.run,
              "model_authority_denied",
              { error: reason! },
              current.task.id,
              current.attempt.id,
            );
          }
        }, context);
      // Ordinary hook throws are reported and ignored. Native abort marks this invocation's
      // Context before joining it, so the hook exits cancelled and no provider request starts.
      await this.harness.abortTask(api.taskId, context);
      throw new Error("Conversation no longer has model authority");
    }
  }
  private async state(runId: string, context: Context = C): Promise<DomainState> {
    const state = await this.harness.snapshot(DomainDoc, nativeConversation(runId), context);
    if (!state) throw new Error("Run state unavailable");
    return state;
  }
  private async runId(name: string, context: Context = C): Promise<string> {
    const directory = await this.harness.snapshot(DirectoryDoc, context);
    const id =
      (directory && Object.hasOwn(directory.runs, name) ? directory.runs[name] : undefined) ??
      (Object.values(directory?.runs ?? {}).includes(name) ? name : undefined);
    if (!id) throw new Error(`No run named ${name}`);
    return id;
  }
  private async taskRun(taskId: string, context: Context = C): Promise<string> {
    const native = await this.harness.getTask(nativeTask(taskId), context);
    const input = native?.input as unknown as AgentInput | undefined;
    if (native?.kind !== this.agentJob.definition.name || !input?.runId) throw new Error("Unknown task");
    return input.runId;
  }
  private async bound(id: ConversationId, context: Context = C): Promise<Scope | undefined> {
    const binding = await this.harness.snapshot(BindingDoc, id, context);
    if (!binding?.runId) return;
    return scope(await this.state(binding.runId, context), binding.attemptId);
  }
  private async operationRun(operation: Operation, context: Context = C): Promise<string | undefined> {
    if (operation.type === "start") return;
    if ("name" in operation) return this.runId(operation.name, context);
    if ("taskId" in operation) return this.taskRun(operation.taskId, context);
    const native = await this.harness.getTask(nativeTask(operation.questionId), context);
    if (!native) throw new Error("Unknown question");
    const binding = await this.harness.snapshot(BindingDoc, native.conversationId, context);
    if (!binding?.runId) throw new Error("Question has no run");
    return binding.runId;
  }
  private role(owned: Scope): AgentDefinition {
    const role = owned.task.role && owned.run.catalog?.agents[owned.task.role];
    if (!role) throw new Error("Missing frozen agent definition");
    return role;
  }
  private requireActive(owned: Scope): void {
    if (
      owned.run.desired !== "running" ||
      owned.attempt.desired !== "running" ||
      owned.task.currentAttemptId !== owned.attempt.id ||
      closed(owned.task)
    )
      throw new Error("This task no longer accepts input");
    if (Date.now() >= owned.run.deadline) throw new Error("Run deadline reached");
  }
  private async waitFor(
    runId: string,
    predicate: (state: DomainState) => unknown,
    signal: AbortSignal,
    context: Context,
  ): Promise<DomainState> {
    const watch = await this.harness.watchDoc(DomainDoc, nativeConversation(runId), context);
    if (!watch) throw new Error("Domain state unavailable");
    let aborted: () => void = () => {};
    try {
      return await new Promise<DomainState>((done, reject) => {
        const check = (value: Readonly<DomainState & JsonObject> | null) => {
          try {
            if (value && predicate(value)) done(value);
          } catch (error) {
            reject(error);
          }
        };
        aborted = () => reject(new Error("Native task invocation interrupted"));
        signal.addEventListener("abort", aborted, { once: true });
        watch.start(async (value) => {
          check(value);
        });
        check(watch.value);
        void watch.closed.then(() => reject(new Error("Run observation closed")));
        if (signal.aborted) aborted();
      });
    } finally {
      signal.removeEventListener("abort", aborted);
      await watch.stop();
    }
  }

  private async command(operation: Operation, id: string, context: Context = C): Promise<JsonValue> {
    if (!id || id.length > 256) throw new Error("Invalid command identity");
    const input: OperatorInput = { operationId: id, operation },
      runId = await this.operationRun(operation, context),
      control = runId
        ? await this.harness.conversation(nativeConversation(runId), context)
        : await this.harness.root(context);
    if (!control) throw new Error("Run control conversation unavailable");
    const native = await control.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanTasks(
          { conversationId: control.id, kind: this.operatorJob.definition.name },
          1000,
          cursor,
        );
        for (const task of page.items) {
          const old = task.input as unknown as OperatorInput;
          if (old.operationId === id) {
            if (canonical(old) !== canonical(input))
              throw new Error("Command ID was reused with another payload");
            return nativeTask<JsonValue>(task.id);
          }
        }
        cursor = page.next;
      } while (cursor);
      return tx.createTask(this.operatorJob, input, {
        ownership: { kind: "conversation" },
        background: true,
      });
    }, context);
    this.harness.resume();
    const result = await this.harness.waitForTask(native, context);
    if (result.state.outcome.status !== "completed")
      throw new Error(
        result.state.outcome.status === "failed" || result.state.outcome.status === "faulted"
          ? result.state.outcome.error.message
          : `Operator action ${result.state.outcome.status}`,
      );
    return result.state.outcome.result;
  }
  private async decide(
    id: string,
    input: OperatorInput,
    runtime: TaskRuntime<OperatorInput, OperatorState, JsonValue, object>,
    context: Context,
  ): Promise<void> {
    const runId = await this.operationRun(input.operation, context);
    const start = input.operation.type === "start" ? input.operation : null;
    if (start) this.validateStart(start.input);
    const catalog = start?.input.agent
      ? this.freeze(
          start.input.agent,
          start.catalogFile
            ? loadCatalog(start.catalogFile)
            : (this.options.catalog ?? loadCatalog(this.options.catalogFile)),
        )
      : null;
    const cwd = start ? realpathSync(start.input.cwd) : null;
    if (cwd && !statSync(cwd).isDirectory()) throw new Error("Working directory must be a directory");
    await runtime.commit(async (tx) => {
      const state = runId
          ? await draft(tx, runId)
          : { detail: null, integrationOwner: null, applyOwner: null },
        operation = input.operation;
      let result: JsonValue = null,
        abort: string[] = [];
      if (
        state.applyOwner &&
        operation.type !== "apply" &&
        ["stop", "retry", "revise", "integrate"].includes(operation.type)
      )
        throw new Error("The accepted tree is being applied; wait for that operator action to finish");
      if (operation.type === "start") {
        const value = operation.input,
          directory = await tx.doc(DirectoryDoc);
        const name = value.name ?? `run-${id}`;
        if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) || Object.hasOwn(directory.runs, name))
          throw new Error("Run name is invalid or already exists");
        if (value.agent && value.model) throw new Error("Agent models are declared in the frozen catalog");
        if ((value.repos?.length || value.workspace) && !value.agent)
          throw new Error("Repository inputs and writable workspaces require --agent");
        const paths = [...(value.workspace?.includeUntracked ?? [])];
        this.validatePaths(paths);
        const limits = { ...DEFAULT_RUN_LIMITS, ...this.options.limits };
        this.validateLimits(limits);
        const control = await tx.createConversation({ ownership: { kind: "ownerless" } });
        const run: Run = {
          id: String(control.id),
          name,
          cwd: cwd!,
          model: value.model ?? this.environment.PITUITARY_MODEL ?? null,
          objective: value.prompt ?? "",
          created: new Date().toISOString(),
          desired: "running",
          rootTaskId: "",
          catalog,
          limits,
          deadline: Date.now() + limits.deadlineMs,
          repos: [...(value.repos ?? [])],
          workspace: value.workspace ? { includeUntracked: paths } : null,
          inputArtifactId: null,
          integrationArtifactId: null,
          acceptedArtifactId: null,
        };
        const detail: RunState = {
          run,
          tasks: [],
          attempts: [],
          reports: [],
          artifacts: [],
          integrations: [],
          verifications: [],
          questions: [],
        };
        const created = await this.createAgent(
          tx,
          detail,
          null,
          value.agent ?? null,
          run.objective,
          [],
          [],
          id,
        );
        run.rootTaskId = created.id;
        detail.run = run;
        const createdState = await draft(tx, run.id);
        createdState.detail = detail;
        directory.runs[name] = run.id;
        await tx.createTask(
          this.deadlineJob,
          { runId: run.id, at: run.deadline },
          { ownership: { kind: "conversation" }, conversationId: control.id, background: true },
        );
        await event(tx, run, "run_created", { name, cwd }, created.id, created.currentAttemptId);
        result = run.id;
      } else if (operation.type === "recover") {
        return { status: "running", checkpoint: { phase: "recover", runId: runId! } };
      } else if (operation.type === "stop") {
        const detail = locate(state, operation.name);
        detail.run.desired = "stopped";
        detail.run.acceptedArtifactId = null;
        abort = this.revoke(
          detail,
          detail.tasks.map((task) => task.id),
          "cancelled",
        );
        await event(tx, detail.run, "stop_requested");
        result = detail.run.id;
      } else if (operation.type === "answer") {
        if (!operation.answer.trim() || Buffer.byteLength(operation.answer) > 64 * 1024)
          throw new Error("Invalid operator answer");
        const detail = state.detail;
        if (!detail) throw new Error("Unknown question");
        const question = detail.questions.find((item) => item.id === operation.questionId)!;
        const owned = scope(state, question.attemptId);
        this.requireActive(owned);
        if (question.status !== "open" || question.revision !== owned.task.revision)
          throw new Error("Question is no longer current");
        replace(detail.questions, {
          ...question,
          status: "answered",
          answer: operation.answer,
          answeredAt: new Date().toISOString(),
        });
        await this.queueDelivery(
          tx,
          owned,
          owned.task.id,
          null,
          `Operator answered question ${question.id}:\n${question.question}\n\n${operation.answer}`,
          question.id,
        );
        await event(
          tx,
          detail.run,
          "operator_answered",
          { questionId: question.id },
          owned.task.id,
          owned.attempt.id,
        );
        result = question.id;
      } else if (operation.type === "apply") {
        const { run } = locate(state, operation.name);
        if (
          !run.inputArtifactId ||
          !run.acceptedArtifactId ||
          run.acceptedArtifactId !== run.integrationArtifactId
        )
          throw new Error("Run has no current independently accepted code result");
        if (state.applyOwner && state.applyOwner !== id)
          throw new Error("Another apply action owns this run");
        state.applyOwner = id;
        result = { runId: run.id, inputArtifactId: run.inputArtifactId, artifactId: run.acceptedArtifactId };
        await event(tx, run, "apply_requested", result);
        return {
          status: "running",
          checkpoint: {
            phase: "apply",
            intent: {
              runId: run.id,
              inputArtifactId: run.inputArtifactId,
              artifactId: run.acceptedArtifactId,
            },
          },
        };
      } else {
        const owned = taskScope(state, operation.taskId);
        if (owned.task.revision !== operation.revision)
          throw new Error("Task revision changed; inspect its current revision");
        if (operation.type === "integrate") {
          if (!owned.task.artifactId || !this.inputsCurrent(owned))
            throw new Error("Task has no current retained result");
          const integration = await this.queueIntegration(tx, owned);
          result = integration.id;
        } else {
          let task = owned.task;
          if (operation.type === "revise") {
            this.validateRevision(operation.input);
            task = {
              ...task,
              revision: task.revision + 1,
              objective: operation.input.objective ?? task.objective,
              acceptance: [...(operation.input.acceptance ?? task.acceptance)],
              inputArtifactId: this.revisionInput(state, owned, operation.input.inputArtifactId),
              dependencies: this.dependencies(
                owned.detail,
                operation.input.dependsOn ?? task.dependencies.map((item) => item.taskId),
              ),
            };
            if (
              task.inputArtifactId &&
              !owned.detail.artifacts.some((item) => item.id === task.inputArtifactId)
            )
              throw new Error("Input artifact belongs to another run");
          } else if (!this.inputsCurrent(owned))
            throw new Error("Inputs changed; revise the task before retrying");
          if (Date.now() >= owned.run.deadline) throw new Error("Run deadline reached; start a new run");
          const stale = this.invalidate(owned.detail, owned.task.id);
          if (task.dependencies.some((dependency) => stale.has(dependency.taskId)))
            throw new Error("Revision would invalidate a selected dependency");
          abort = this.revoke(owned.detail, [...stale], "superseded");
          await this.rebuild(tx, state, owned.detail, stale);
          owned.detail.run.desired = "running";
          const current = await this.createAttempt(
            tx,
            owned.detail,
            task,
            owned.attempt.depth,
            owned.attempt.grant,
          );
          result = current.id;
          await event(
            tx,
            owned.run,
            operation.type === "retry" ? "task_retried" : "task_revised",
            {
              revision: current.revision,
              inputArtifactId: current.inputArtifactId,
              explicitInput: operation.type === "revise" && operation.input.inputArtifactId !== undefined,
            },
            current.id,
            current.currentAttemptId,
          );
          if (current.parentTaskId)
            await this.queueDelivery(
              tx,
              { ...owned, task: current },
              current.parentTaskId,
              null,
              `Operator started a new attempt for task ${current.id} revision ${current.revision}. Earlier results are no longer current; inspect the task before relying on them.`,
            );
        }
      }
      return {
        status: "running",
        checkpoint: abort.length ? { phase: "abort", attempts: abort, result } : { phase: "finish", result },
      };
    }, context);
  }
  private validateStart(value: StartRunInput): void {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["name", "cwd", "prompt", "agent", "model", "repos", "workspace"].includes(key),
      )
    )
      throw new Error("Invalid run input");
    if (typeof value.cwd !== "string" || !value.cwd.length) throw new Error("Working directory is required");
    if (
      value.name !== undefined &&
      (typeof value.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value.name))
    )
      throw new Error("Invalid run name");
    if (
      value.prompt !== undefined &&
      (typeof value.prompt !== "string" || Buffer.byteLength(value.prompt) > 65536)
    )
      throw new Error("Objective exceeds 64 KiB");
    if (
      value.agent !== undefined &&
      (typeof value.agent !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value.agent))
    )
      throw new Error("Invalid agent name");
    if (value.model !== undefined) {
      if (typeof value.model !== "string") throw new Error("Invalid model");
      this.modelRef(value.model);
    }
    if (
      value.repos !== undefined &&
      (!Array.isArray(value.repos) ||
        value.repos.length > 32 ||
        value.repos.some(
          (item) => typeof item !== "string" || !item.length || Buffer.byteLength(item) > 4096,
        ))
    )
      throw new Error("Invalid repository inputs");
    if (
      value.workspace !== undefined &&
      (!value.workspace ||
        typeof value.workspace !== "object" ||
        Array.isArray(value.workspace) ||
        Object.keys(value.workspace).some((key) => key !== "includeUntracked") ||
        (value.workspace.includeUntracked !== undefined && !Array.isArray(value.workspace.includeUntracked)))
    )
      throw new Error("Invalid workspace input");
  }
  private validateLimits(limits: RunLimits): void {
    for (const [key, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || value < (key === "maxDepth" ? 0 : 1))
        throw new Error(`Invalid run limit ${key}`);
    if (limits.artifactBytes > 128 * 1024 * 1024 || limits.reportBytes > 64 * 1024)
      throw new Error("Artifact/report byte limit exceeds its transport bound");
  }
  private validatePaths(paths: readonly string[]): void {
    if (
      paths.length > 1024 ||
      new Set(paths).size !== paths.length ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          !path.length ||
          path.startsWith("/") ||
          path.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git"),
      )
    )
      throw new Error("Untracked inputs must be explicit relative paths inside the workspace");
  }
  private revisionInput(state: DomainState, owned: Scope, explicit: string | undefined): string | null {
    if (explicit !== undefined) return explicit;
    if (owned.task.status !== "superseded") return owned.task.inputArtifactId;
    const previous = owned.detail.integrations.find((item) => item.id === owned.task.integrationId);
    if (previous?.status === "integrated") return owned.task.inputArtifactId;
    const replay = owned.detail.integrations.some(
      (item) =>
        item.status === "pending" && owned.detail.tasks.some((task) => task.integrationId === item.id),
    );
    if (state.integrationOwner || replay)
      throw new Error(
        "Integration replay is still pending; wait before revising superseded work or explicitly choose its input",
      );
    return owned.run.integrationArtifactId ?? owned.run.inputArtifactId;
  }
  private validateRevision(value: ReviseTaskInput): void {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["objective", "acceptance", "inputArtifactId", "dependsOn"].includes(key),
      )
    )
      throw new Error("Invalid task revision");
    if (
      value.objective !== undefined &&
      (typeof value.objective !== "string" ||
        !value.objective.trim() ||
        Buffer.byteLength(value.objective) > 64 * 1024)
    )
      throw new Error("Invalid revision objective");
    if (
      value.acceptance !== undefined &&
      (!Array.isArray(value.acceptance) ||
        value.acceptance.length > 32 ||
        value.acceptance.some(
          (item) => typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > 4096,
        ))
    )
      throw new Error("Invalid revision acceptance conditions");
    if (
      value.dependsOn !== undefined &&
      (!Array.isArray(value.dependsOn) || value.dependsOn.some((item) => typeof item !== "string"))
    )
      throw new Error("Invalid dependency IDs");
    if (value.inputArtifactId !== undefined && typeof value.inputArtifactId !== "string")
      throw new Error("Invalid input artifact ID");
  }
  private freeze(root: string, source: AgentCatalog): AgentCatalog {
    const agents: Record<string, AgentDefinition> = Object.create(null),
      active = new Set<string>();
    const visit = (name: string) => {
      if (agents[name]) return;
      const definition = Object.hasOwn(source.agents, name) ? source.agents[name] : undefined;
      if (!definition) throw new Error(`Undeclared agent ${name}`);
      agents[name] = structuredClone(definition);
      for (const child of definition.manifest.delegatesTo) visit(child);
      if (definition.verification) visit(definition.verification.agent);
    };
    visit(root);
    const activate = (name: string) => {
      if (active.has(name)) return;
      active.add(name);
      for (const child of agents[name]!.manifest.delegatesTo) activate(child);
    };
    activate(root);
    for (const name of active) {
      const definition = agents[name]!,
        model = definition.manifest.model ?? this.environment.PITUITARY_MODEL;
      if (!model) throw new Error(`Agent ${name} requires an explicit model or PITUITARY_MODEL`);
      this.modelRef(model);
      definition.manifest = { ...definition.manifest, model };
      this.authorizeModel(definition.manifest);
    }
    return { schemaVersion: 1, baySocket: source.baySocket, agents };
  }

  private async createAgent(
    tx: Tx,
    detail: RunState,
    parent: Scope | null,
    role: string | null,
    objective: string,
    acceptance: readonly string[],
    dependencies: readonly TaskDependency[],
    origin: string,
  ): Promise<DomainTask> {
    const existing = detail.tasks.find((item) => item.origin === origin);
    if (existing) return existing;
    if (detail.tasks.length >= detail.run.limits.maxTasks) throw new Error("Run task limit reached");
    const depth = parent ? parent.attempt.depth + 1 : 0,
      definition = role ? detail.run.catalog?.agents[role] : undefined;
    if (role && !definition) throw new Error("Missing frozen role");
    const ceiling = definition?.manifest.limits ?? { maxChildren: 0, maxDepth: 0 };
    const task: DomainTask = {
      id: "",
      origin,
      runId: detail.run.id,
      parentTaskId: parent?.task.id ?? null,
      role,
      revision: 1,
      inputArtifactId: detail.run.integrationArtifactId,
      dependencies: [...dependencies],
      objective,
      acceptance: [...acceptance],
      status: "queued",
      currentAttemptId: "",
      waitFor: [],
      reportId: null,
      artifactId: null,
      integrationId: null,
      verificationId: null,
    };
    return this.createAttempt(tx, detail, task, depth, {
      maxChildren: ceiling.maxChildren,
      maxDepth: Math.min(
        ceiling.maxDepth,
        parent ? parent.attempt.grant.maxDepth - 1 : detail.run.limits.maxDepth,
        detail.run.limits.maxDepth - depth,
      ),
    });
  }
  private async createAttempt(
    tx: Tx,
    detail: RunState,
    task: DomainTask,
    depth: number,
    grant: Attempt["grant"],
  ): Promise<DomainTask> {
    const old = detail.attempts.filter((item) => item.taskId === task.id),
      parent = task.parentTaskId ? detail.tasks.find((item) => item.id === task.parentTaskId) : null,
      owner =
        parent && detail.attempts.find((item) => item.id === parent.currentAttemptId)?.desired === "running"
          ? parent
          : null;
    const native = await tx.createTask(
      this.agentJob,
      { runId: detail.run.id },
      {
        ownership: owner
          ? { kind: "task", taskId: nativeTask(owner.currentAttemptId) }
          : { kind: "conversation" },
        conversationId: nativeConversation(detail.run.id),
        ...(!owner ? { background: true } : {}),
      },
    );
    const current = {
      ...task,
      id: task.id || String(native),
      currentAttemptId: String(native),
      status: "queued" as const,
      reportId: null,
      artifactId: null,
      integrationId: null,
      verificationId: null,
      waitFor: [],
    };
    const attempt: Attempt = {
      id: String(native),
      taskId: current.id,
      number: old.length + 1,
      revision: current.revision,
      inputArtifactId: current.inputArtifactId,
      dependencies: [...current.dependencies],
      depth,
      conversationId: null,
      cwd: current.role ? "/work" : detail.run.cwd,
      status: "queued",
      desired: "running",
      error: null,
      execution: null,
      grant,
    };
    replace(detail.tasks, current);
    detail.attempts.push(attempt);
    detail.run.acceptedArtifactId = null;
    return current;
  }

  private async capture(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    let artifact: Artifact | undefined;
    if (owned.run.workspace && !owned.run.inputArtifactId && !owned.task.parentTaskId)
      artifact = await this.workspaces.capture(owned.run, runtime.signal);
    await runtime.commit(async (tx) => {
      const state = await draft(tx, String(runtime.conversationId)),
        current = scope(state, id);
      this.requireActive(current);
      if (artifact) {
        this.retain(current, artifact);
        current.detail.run.inputArtifactId = artifact.id;
        current.detail.run.integrationArtifactId = artifact.id;
        replace(current.detail.tasks, { ...current.task, inputArtifactId: artifact.id });
        replace(current.detail.attempts, { ...current.attempt, inputArtifactId: artifact.id });
        await event(
          tx,
          current.run,
          "input_retained",
          { artifactId: artifact.id, tree: artifact.tree },
          current.task.id,
          id,
        );
      }
      return { status: "running", checkpoint: { phase: "provision", dispatched: false } };
    }, context);
  }
  private async provision(
    id: string,
    checkpoint: Extract<AgentState, { phase: "provision" }>,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    this.requireActive(owned);
    const definition = owned.task.role ? this.role(owned) : null;
    if (definition) {
      const model = definition.manifest.model ?? this.environment.PITUITARY_MODEL;
      if (!model)
        throw new Error(`Agent ${definition.manifest.name} requires an explicit model or PITUITARY_MODEL`);
      this.authorizeModel({ ...definition.manifest, model });
    }
    if (!checkpoint.dispatched) {
      let admitted = false;
      await runtime.commit(async (tx) => {
        const current = scope(await draft(tx, String(runtime.conversationId)), id);
        this.requireActive(current);
        const live =
          current.detail.attempts.filter(
            (attempt) =>
              attempt.id !== id &&
              attempt.desired === "running" &&
              !["queued", "stopped", "failed"].includes(attempt.status),
          ).length + current.detail.verifications.filter((item) => item.status === "running").length;
        if (live >= current.run.limits.maxLiveAttempts)
          return { status: "sleeping", until: Date.now() + 1000, checkpoint };
        admitted = true;
        replace(current.detail.attempts, {
          ...current.attempt,
          status: definition ? "starting" : "ready",
          error: null,
        });
        return {
          status: "running",
          checkpoint: definition ? { phase: "provision", dispatched: true } : { phase: "materialize" },
        };
      }, context);
      if (!admitted || !definition) return;
    }
    if (!definition) throw new Error("Local execution cannot carry a remote dispatch intent");
    const bay = new Bay(owned.run.catalog!.baySocket, runtime.signal),
      name = baySessionName(this.namespace, "agent", id);
    let session: Awaited<ReturnType<Bay["get"]>>;
    if (checkpoint.dispatched) {
      try {
        session = await bay.get(name);
      } catch (error) {
        if (error instanceof BayError && error.status === 404)
          throw new Error("Bay launch outcome is unknown; its create command will not be repeated");
        throw error;
      }
    } else {
      try {
        session = await bay.start(name, definition, owned.run.repos);
      } catch (error) {
        if (error instanceof BayError && error.code === "capacity_exhausted") {
          await runtime.commit(async (tx) => {
            const current = scope(await draft(tx, String(runtime.conversationId)), id);
            replace(current.detail.attempts, { ...current.attempt, status: "queued" });
            return {
              status: "sleeping",
              until: Date.now() + 1000,
              checkpoint: { phase: "provision", dispatched: false },
            };
          }, context);
          return;
        }
        throw error;
      }
    }
    assertBaySession(session, {
      name,
      agent: definition,
      id: owned.attempt.execution?.recordId,
      generation: owned.attempt.execution?.generation ?? 1,
    });
    if (session.state !== "running")
      throw new Error(`Pinned agent environment is ${session.state}; explicit retry is required`);
    await runtime.commit(async (tx) => {
      const current = scope(await draft(tx, String(runtime.conversationId)), id);
      const execution = {
        kind: "bay" as const,
        socket: owned.run.catalog!.baySocket,
        sessionName: name,
        recordId: session.id,
        generation: session.generation,
        agent: definition,
        repos: session.repos?.map((repo) => `${repo.owner}/${repo.name}@${repo.commit}`) ?? owned.run.repos,
      };
      replace(current.detail.attempts, { ...current.attempt, execution, status: "ready", error: null });
      if (!current.task.parentTaskId)
        current.detail.run.repos = [
          ...(session.repos?.map((repo) => `${repo.owner}/${repo.name}@${repo.commit}`) ?? owned.run.repos),
        ];
      await event(
        tx,
        current.run,
        "environment_ready",
        { recordId: session.id, generation: session.generation },
        current.task.id,
        id,
      );
      return { status: "running", checkpoint: { phase: "materialize" } };
    }, context);
  }
  private async materialize(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    this.requireActive(owned);
    if (owned.attempt.inputArtifactId) {
      if (!owned.attempt.execution) throw new Error("Writable work requires an isolated Bay machine");
      const artifact = owned.detail.artifacts.find((item) => item.id === owned.attempt.inputArtifactId);
      if (!artifact) throw new Error("Missing immutable input");
      await this.workspaces.materialize(
        owned.run,
        owned.attempt.execution,
        artifact,
        `${id}:input`,
        async () => this.active(String(runtime.conversationId), id),
        runtime.signal,
      );
    }
    await runtime.commit(async (tx) => {
      const current = scope(await draft(tx, String(runtime.conversationId)), id);
      this.requireActive(current);
      const conversation = await tx.createConversation({
        ownership: { kind: "task", taskId: nativeTask(id) },
      });
      const definition = current.task.role ? this.role(current) : null;
      const model = definition
        ? (definition.manifest.model ?? this.environment.PITUITARY_MODEL)
        : current.run.model;
      if (definition && !model)
        throw new Error(`Agent ${definition.manifest.name} requires an explicit model or PITUITARY_MODEL`);
      if (definition) this.authorizeModel({ ...definition.manifest, model: model ?? null });
      const allowed = definition
        ? definition.manifest.tools.map((name) => {
            const tool = codingTools.find((tool) => tool.name === name);
            if (!tool) throw new Error(`Unregistered coding tool ${name}`);
            return tool;
          })
        : [...codingTools];
      const cwd = current.attempt.execution
        ? current.attempt.inputArtifactId
          ? "/work/workspace"
          : "/work"
        : current.run.cwd;
      const binding = await tx.doc(BindingDoc, conversation.id);
      binding.runId = current.run.id;
      binding.taskId = current.task.id;
      binding.attemptId = id;
      await configure(tx, conversation.id, {
        extensions: [codingExtension, this.extension],
        tools: definition ? [...allowed, ...this.tools] : allowed,
        instructions: definition?.manifest.instructions ?? "",
        cwd,
        ...(model ? { model: this.modelRef(model) } : {}),
      });
      replace(current.detail.attempts, {
        ...current.attempt,
        conversationId: String(conversation.id),
        cwd,
        status: "ready",
      });
      replace(current.detail.tasks, { ...current.task, status: "running" });
      await event(
        tx,
        current.run,
        "conversation_created",
        { conversationId: conversation.id },
        current.task.id,
        id,
      );
      return { status: "running", checkpoint: { phase: "start" } };
    }, context);
  }
  private async begin(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    this.requireActive(owned);
    if (!owned.attempt.conversationId) throw new Error("Missing agent conversation binding");
    if (owned.task.objective) {
      const conversation = await runtime.conversation(
        nativeConversation(owned.attempt.conversationId),
        context,
      );
      if (!conversation) throw new Error("Missing agent conversation");
      await conversation.submit(
        { type: "input", requestId: `${id}:objective`, content: this.prompt(owned) },
        context,
      );
    }
    await runtime.commit(() => ({ status: "running", checkpoint: { phase: "await_result" } }), context);
  }
  private async awaitResult(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const state = await this.waitFor(
      String(runtime.conversationId),
      (state) => {
        const current = scope(state, id);
        return (
          current.task.reportId || current.attempt.desired === "stopped" || current.run.desired === "stopped"
        );
      },
      runtime.signal,
      context,
    );
    const owned = scope(state, id);
    if (
      owned.run.desired !== "running" ||
      owned.attempt.desired !== "running" ||
      owned.task.currentAttemptId !== id
    ) {
      await this.abortAgent(id, runtime, context);
      return;
    }
    this.requireResultCurrent(owned);
    if (!owned.attempt.conversationId) throw new Error("Missing agent conversation binding");
    const conversation = await this.harness.conversation(
      nativeConversation(owned.attempt.conversationId),
      context,
    );
    if (conversation) await conversation.waitForIdle(context);
    await runtime.commit(
      () => ({
        status: "running",
        checkpoint: { phase: owned.task.status === "submitting" ? "export" : "finish" },
      }),
      context,
    );
  }
  private async exportResult(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    this.requireResultCurrent(owned);
    const input = owned.detail.artifacts.find((item) => item.id === owned.attempt.inputArtifactId);
    if (!input) throw new Error("Missing result input snapshot");
    const artifact = await this.workspaces.export(owned, input, `${id}:export`, runtime.signal);
    await runtime.commit(async (tx) => {
      const current = scope(await draft(tx, String(runtime.conversationId)), id);
      this.requireResultCurrent(current);
      this.retain(current, artifact);
      const task = { ...current.task, artifactId: artifact.id, status: "submitted" as const };
      replace(current.detail.tasks, task);
      await this.queueIntegration(tx, { ...current, task });
      await this.reportNotice(tx, { ...current, task });
      await event(
        tx,
        current.run,
        "result_retained",
        { artifactId: artifact.id, tree: artifact.tree },
        task.id,
        id,
      );
      return { status: "running", checkpoint: { phase: "finish" } };
    }, context);
  }
  private async finishAgent(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    if (owned.attempt.conversationId) await this.closeEnvironments(owned.attempt.conversationId);
    if (owned.attempt.execution && !this.closing) {
      const execution = owned.attempt.execution;
      await new Bay(execution.socket, runtime.signal).suspend(
        execution.sessionName,
        execution.recordId,
        execution.generation,
      );
    }
    await runtime.commit(async (tx) => {
      const current = scope(await draft(tx, String(runtime.conversationId)), id);
      replace(current.detail.attempts, { ...current.attempt, desired: "stopped", status: "stopped" });
      await event(tx, current.run, "environment_suspended", {}, current.task.id, id);
      this.acceptance(current.detail);
      return { status: "terminal", outcome: { status: "completed", result: null } };
    }, context);
  }
  private async abortAgent(
    id: string,
    runtime: TaskRuntime<AgentInput, AgentState, null, object>,
    context: Context,
  ): Promise<void> {
    const owned = scope(await this.state(String(runtime.conversationId), context), id);
    if (owned.attempt.conversationId) await this.closeEnvironments(owned.attempt.conversationId);
    if (!this.closing) await this.suspendAttempt(String(runtime.conversationId), id, context);
    await runtime.commit(async (tx) => {
      const current = scope(await draft(tx, String(runtime.conversationId)), id);
      replace(current.detail.attempts, { ...current.attempt, desired: "stopped", status: "stopped" });
      if (
        current.task.currentAttemptId === id &&
        !["superseded", "submitted", "accepted", "conflicted"].includes(current.task.status)
      )
        replace(current.detail.tasks, { ...current.task, status: "cancelled" });
      this.acceptance(current.detail);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  }
  private async suspendAttempt(runId: string, id: string, context: Context): Promise<void> {
    const owned = scope(await this.state(runId, context), id);
    let execution = owned.attempt.execution;
    if (
      !execution &&
      owned.task.role &&
      ["starting", "unreachable", "interrupted"].includes(owned.attempt.status)
    ) {
      const bay = new Bay(owned.run.catalog!.baySocket, AbortSignal.timeout(10_000)),
        name = baySessionName(this.namespace, "agent", id);
      // The POST intent is durable. An absent GET cannot prove an in-flight create did not succeed.
      const session = await bay.get(name);
      assertBaySession(session, { name, agent: this.role(owned), generation: 1 });
      execution = {
        kind: "bay",
        socket: owned.run.catalog!.baySocket,
        sessionName: name,
        recordId: session.id,
        generation: session.generation,
        agent: this.role(owned),
        repos: session.repos?.map((repo) => `${repo.owner}/${repo.name}@${repo.commit}`) ?? owned.run.repos,
      };
      const pinned = execution;
      await this.harness.commit(async (tx) => {
        const current = scope(await draft(tx, runId), id);
        if (current.attempt.execution && canonical(current.attempt.execution) !== canonical(pinned))
          throw new Error("Execution identity changed during cleanup");
        replace(current.detail.attempts, { ...current.attempt, execution: pinned });
      }, context);
    }
    if (execution)
      await new Bay(execution.socket, AbortSignal.timeout(10_000)).suspend(
        execution.sessionName,
        execution.recordId,
        execution.generation,
      );
    await this.harness.commit(async (tx) => {
      const current = scope(await draft(tx, runId), id);
      if (current.attempt.desired === "stopped")
        replace(current.detail.attempts, { ...current.attempt, status: "stopped" });
    }, context);
  }
  private async recordFailure(error: unknown, info: ReportInfo): Promise<void> {
    if (
      this.closing ||
      !("task" in info) ||
      !info.task ||
      !["task_faulted", "task_parked", "migration_failed", "task_outdated"].includes(info.type)
    )
      return;
    const native = await this.harness.getTask(info.task.id, C);
    if (!native) return;
    const input = native.input as unknown as AgentInput | ResultInput;
    const binding = await this.harness.snapshot(BindingDoc, info.task.conversationId, C),
      runId = binding?.runId || input.runId;
    if (!runId) return;
    await this.harness.commit(async (tx) => {
      const state = await draft(tx, runId),
        detail = locate(state, runId),
        attempt = detail.attempts.find((item) => item.id === (binding?.attemptId || String(native.id)));
      if (attempt && attempt.desired === "running") {
        replace(detail.attempts, {
          ...attempt,
          status: attempt.status === "queued" ? "failed" : "interrupted",
          error: String(error),
        });
        await event(
          tx,
          detail.run,
          "attempt_attention",
          { nativeTaskId: native.id, error: String(error), reason: info.type },
          attempt.taskId,
          attempt.id,
        );
      }
      const integration = detail.integrations.find((item) => item.id === String(native.id));
      if (integration) replace(detail.integrations, { ...integration, error: String(error) });
      const verification = detail.verifications.find((item) => item.id === String(native.id));
      if (verification) replace(detail.verifications, { ...verification, error: String(error) });
    }, C);
  }
  private async active(runId: string, id: string): Promise<boolean> {
    if (this.closing) return false;
    try {
      const owned = scope(await this.state(runId), id);
      return (
        owned.run.desired === "running" &&
        owned.attempt.desired === "running" &&
        owned.task.currentAttemptId === id
      );
    } catch {
      return false;
    }
  }
  private requireResultCurrent(owned: Scope): void {
    if (
      owned.run.desired !== "running" ||
      owned.attempt.desired !== "running" ||
      ["superseded", "cancelled", "failed"].includes(owned.task.status) ||
      owned.task.currentAttemptId !== owned.attempt.id ||
      owned.task.revision !== owned.attempt.revision ||
      !this.inputsCurrent(owned)
    )
      throw new Error("Result authority changed");
  }
  private modelRef(value: string): { provider: string; modelId: string } {
    const index = value.indexOf("/");
    if (index < 1 || index === value.length - 1) throw new Error("Model must be provider/model");
    return { provider: value.slice(0, index), modelId: value.slice(index + 1) };
  }
  private prompt(owned: Scope): string {
    return [
      `Task ${owned.task.id}, revision ${owned.task.revision}`,
      owned.task.parentTaskId ? `Parent task: ${owned.task.parentTaskId} (message recipient: parent)` : "",
      "Objective:",
      owned.task.objective,
      ...owned.task.acceptance.map((item) => `Acceptance: ${item}`),
      ...(owned.attempt.inputArtifactId
        ? [
            `Immutable writable input: ${owned.attempt.inputArtifactId}. Work in /work/workspace. Submit artifact:true to retain code.`,
          ]
        : []),
      ...owned.run.repos.map((repo) => `Exact read-only context: ${repo}`),
      ...owned.task.dependencies.map(
        (item) =>
          `Dependency ${item.taskId} revision ${item.revision}: report ${item.reportId}, artifact ${item.artifactId}`,
      ),
      "Use ask/yield/submit alone in a tool round. Reports and test claims are unverified; only host independent checks can accept code.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private makeTools(): readonly ToolRegistration[] {
    const descriptions = {
      delegate: "Delegate a bounded task to a declared agent.",
      inspect: "Inspect current task and result identities.",
      message: "Send attributable context to another task or the operator.",
      ask: "Ask the operator a question and end this turn until an answer arrives.",
      submit: "Submit an immutable report; set artifact:true to retain code. This ends the turn.",
      yield: "End this turn while waiting for relevant results or messages.",
    };
    return (Object.keys(commandSchemas) as CommandName[]).map((name) =>
      defineTool({
        name,
        description: descriptions[name],
        parameters: commandSchemas[name],
        replay: "safe",
        execute: async (args, api, context) => {
          const terminal = ["ask", "yield", "submit"].includes(name);
          if (terminal) {
            const native = await api.getTask(api.taskId, context),
              input = native?.input as unknown as {
                kind?: string;
                assistant?: import("@earendil-works/pi-durable").EntryId;
              };
            if (input?.kind === "model" && input.assistant) {
              const entry = await api.commit((tx) => tx.entry(input.assistant!), context);
              const calls =
                entry?.model?.flatMap((message) =>
                  message.role === "assistant"
                    ? message.content.filter((part) => part.type === "toolCall")
                    : [],
                ) ?? [];
              if (calls.length !== 1) throw new Error(`${name} must be the only tool in its round`);
            }
          }
          const result = await this.tool({ ...args, type: name } as DomainCommand, api, context);
          return {
            output: [{ type: "text" as const, text: canonical(result) }],
            details: result as JsonValue,
            ...(terminal ? { control: { terminate: true } } : {}),
          };
        },
      }),
    );
  }
  private async tool(command: DomainCommand, api: ToolExecutionApi, context: Context): Promise<unknown> {
    const binding = await this.harness.snapshot(BindingDoc, api.conversationId, context);
    if (!binding?.runId) throw new Error("Conversation has no task binding");
    return api.commit(async (tx) => {
      if (command.type === "message") {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanTasks(
            { conversationId: nativeConversation(binding.runId), kind: this.deliveryJob.definition.name },
            1000,
            cursor,
          );
          const previous = page.items.find(
            (item) => (item.input as unknown as DeliveryInput).origin === String(api.taskId),
          );
          if (previous) return { messageId: previous.id, status: "queued" };
          cursor = page.next;
        } while (cursor);
      }
      const state = await draft(tx, binding.runId),
        owned = scope(state, binding.attemptId);
      if (!owned || !owned.task.role) throw new Error("Only declared isolated agents can orchestrate work");
      const existingReport = owned.detail.reports.find((report) => report.id === String(api.taskId));
      if (command.type === "submit" && existingReport)
        return { reportId: existingReport.id, digest: existingReport.digest, status: owned.task.status };
      const existingQuestion = owned.detail.questions.find((question) => question.id === String(api.taskId));
      if (command.type === "ask" && existingQuestion)
        return { questionId: existingQuestion.id, status: existingQuestion.status };
      this.requireActive(owned);
      switch (command.type) {
        case "inspect": {
          const task = command.taskId
            ? owned.detail.tasks.find((item) => item.id === command.taskId)
            : owned.task;
          if (!task) throw new Error("Task is outside this run");
          const report = owned.detail.reports.find((item) => item.id === task.reportId);
          return {
            task: {
              id: task.id,
              role: task.role,
              revision: task.revision,
              status: task.status,
              objective: task.objective.slice(0, 4096),
              acceptance: task.acceptance,
              artifactId: task.artifactId,
              verificationId: task.verificationId,
              ...(report
                ? {
                    report: {
                      id: report.id,
                      digest: report.digest,
                      text: report.text.slice(0, 16384),
                      truncated: report.text.length > 16384,
                    },
                  }
                : {}),
            },
            tasks: owned.detail.tasks.map((item) => ({
              id: item.id,
              parentTaskId: item.parentTaskId,
              role: item.role,
              revision: item.revision,
              status: item.status,
              reportId: item.reportId,
              artifactId: item.artifactId,
            })),
          };
        }
        case "delegate": {
          const existing = owned.detail.tasks.find((item) => item.origin === String(api.taskId));
          if (existing)
            return { taskId: existing.id, attemptId: existing.currentAttemptId, status: existing.status };
          const role = this.role(owned);
          if (!role.manifest.delegatesTo.includes(command.agent) || owned.attempt.grant.maxDepth < 1)
            throw new Error("Role cannot delegate to that agent at this depth");
          let children = 0;
          for (const child of owned.detail.tasks.filter((item) => item.parentTaskId === owned.task.id)) {
            const origin = await tx.task(nativeTask(child.origin));
            if (!origin) throw new Error("Child task has no native creation provenance");
            if (origin.conversationId === api.conversationId) children++;
          }
          if (children >= owned.attempt.grant.maxChildren) throw new Error("Child task limit reached");
          const task = await this.createAgent(
            tx,
            owned.detail,
            owned,
            command.agent,
            command.objective,
            command.acceptance ?? [],
            this.dependencies(owned.detail, command.dependsOn ?? []),
            String(api.taskId),
          );
          await event(
            tx,
            owned.run,
            "task_delegated",
            { parentTaskId: owned.task.id },
            task.id,
            task.currentAttemptId,
          );
          return { taskId: task.id, attemptId: task.currentAttemptId, status: task.status };
        }
        case "ask": {
          const question: Question = {
            id: String(api.taskId),
            runId: owned.run.id,
            taskId: owned.task.id,
            attemptId: owned.attempt.id,
            revision: owned.task.revision,
            question: command.question,
            choices: [...(command.choices ?? [])],
            status: "open",
            answer: null,
            created: new Date().toISOString(),
            answeredAt: null,
          };
          immutable(owned.detail.questions, question);
          replace(owned.detail.tasks, { ...owned.task, status: "waiting" });
          await event(
            tx,
            owned.run,
            "operator_question",
            { questionId: question.id },
            owned.task.id,
            owned.attempt.id,
          );
          return { questionId: question.id, status: "waiting" };
        }
        case "yield":
          replace(owned.detail.tasks, {
            ...owned.task,
            status: "waiting",
            waitFor: owned.detail.tasks
              .filter(
                (item) =>
                  item.parentTaskId === owned.task.id &&
                  !["submitted", "accepted", "superseded", "cancelled", "failed"].includes(item.status),
              )
              .map((item) => item.id),
          });
          return { status: "waiting" };
        case "submit": {
          if (Buffer.byteLength(command.summary) > owned.run.limits.reportBytes)
            throw new Error("Report exceeds its byte limit");
          if (
            owned.detail.questions.some(
              (question) => question.attemptId === owned.attempt.id && question.status === "open",
            )
          )
            throw new Error("An operator question is still unanswered");
          if (
            command.artifact &&
            (!owned.run.workspace || !owned.attempt.inputArtifactId || !owned.attempt.execution)
          )
            throw new Error("Task has no isolated writable input");
          const report: Report = {
            id: String(api.taskId),
            runId: owned.run.id,
            taskId: owned.task.id,
            attemptId: owned.attempt.id,
            revision: owned.task.revision,
            digest: createHash("sha256").update(command.summary).digest("hex"),
            text: command.summary,
            at: new Date().toISOString(),
          };
          immutable(owned.detail.reports, report);
          const task = {
            ...owned.task,
            reportId: report.id,
            status: command.artifact ? ("submitting" as const) : ("submitted" as const),
            waitFor: [],
          };
          replace(owned.detail.tasks, task);
          if (!command.artifact) await this.reportNotice(tx, { ...owned, task });
          await event(
            tx,
            owned.run,
            "report_submitted",
            { reportId: report.id, digest: report.digest },
            task.id,
            owned.attempt.id,
          );
          this.acceptance(owned.detail);
          return { reportId: report.id, digest: report.digest, status: task.status };
        }
        case "message": {
          if (command.to === "operator") throw new Error("Use ask to request an operator answer");
          const to = command.to === "parent" ? owned.task.parentTaskId : command.to;
          if (!to) throw new Error("Task has no parent");
          const target = owned.detail.tasks.find((item) => item.id === to);
          if (!target || closed(target)) throw new Error("Recipient is unavailable in this run");
          if (command.replyTo) {
            const prior = await tx.task(nativeTask(command.replyTo));
            const input = prior?.input as unknown as DeliveryInput;
            if (
              prior?.kind !== this.deliveryJob.definition.name ||
              input.toTaskId !== owned.task.id ||
              input.toAttemptId !== owned.attempt.id ||
              input.fromTaskId !== target.id
            )
              throw new Error("Reply must name a message from this recipient");
          }
          const native = await this.queueDelivery(
            tx,
            owned,
            to,
            owned.task.id,
            `Agent ${owned.task.role} [task ${owned.task.id}, revision ${owned.task.revision}] says:\n${command.body}`,
            command.replyTo,
            String(api.taskId),
          );
          return { messageId: native, status: "queued" };
        }
      }
    }, context);
  }
  private async queueDelivery(
    tx: Tx,
    owned: Scope,
    toTaskId: string,
    fromTaskId: string | null,
    body: string,
    replyTo?: string,
    origin?: string,
  ): Promise<string> {
    const target = owned.detail.tasks.find((task) => task.id === toTaskId);
    if (!target) throw new Error("Unknown delivery recipient");
    return String(
      await tx.createTask(
        this.deliveryJob,
        {
          runId: owned.run.id,
          toTaskId,
          toAttemptId: target.currentAttemptId,
          fromTaskId,
          body,
          ...(replyTo ? { replyTo } : {}),
          ...(origin ? { origin } : {}),
        },
        {
          ownership: { kind: "conversation" },
          conversationId: nativeConversation(owned.run.id),
          background: true,
        },
      ),
    );
  }
  private async reportNotice(tx: Tx, owned: Scope): Promise<void> {
    if (!owned.task.parentTaskId || !owned.task.reportId) return;
    const report = owned.detail.reports.find((item) => item.id === owned.task.reportId);
    if (!report) return;
    await this.queueDelivery(
      tx,
      owned,
      owned.task.parentTaskId,
      owned.task.id,
      `Agent ${owned.task.role} submitted unverified report ${report.id} for task ${owned.task.id} revision ${owned.task.revision}.${owned.task.artifactId ? ` Retained code artifact ${owned.task.artifactId}; independent verification is separate.` : ""}\n\n${Buffer.from(report.text).subarray(0, 60000).toString("utf8")}`,
    );
  }
  private dependencies(detail: RunState, ids: readonly string[]): TaskDependency[] {
    if (ids.length > 32 || new Set(ids).size !== ids.length) throw new Error("Invalid dependencies");
    return ids.map((id) => {
      const task = detail.tasks.find((item) => item.id === id);
      if (
        !task ||
        !task.reportId ||
        (task.artifactId ? task.status !== "accepted" : task.status !== "submitted")
      )
        throw new Error("Dependency has no current accepted result");
      return { taskId: id, revision: task.revision, artifactId: task.artifactId, reportId: task.reportId };
    });
  }
  private inputsCurrent(owned: Scope): boolean {
    return owned.task.dependencies.every((reference) => {
      const task = owned.detail.tasks.find((item) => item.id === reference.taskId);
      return (
        task &&
        task.revision === reference.revision &&
        task.reportId === reference.reportId &&
        task.artifactId === reference.artifactId &&
        !["failed", "cancelled", "superseded"].includes(task.status)
      );
    });
  }
  private retain(owned: Scope, artifact: Artifact): void {
    if (
      artifact.runId !== owned.run.id ||
      artifact.repository !== "workspace" ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > owned.run.limits.artifactBytes ||
      !/^[a-f0-9]{64}$/.test(artifact.id) ||
      !/^[a-f0-9]{64}$/.test(artifact.content) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.tree) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.head)
    )
      throw new Error("Invalid retained artifact identity");
    if (artifact.kind === "result") {
      const input = owned.detail.artifacts.find((item) => item.id === owned.attempt.inputArtifactId);
      if (
        !input ||
        artifact.base !== input.head ||
        artifact.taskId !== owned.task.id ||
        artifact.attemptId !== owned.attempt.id
      )
        throw new Error("Result artifact does not match its immutable input");
    }
    immutable(owned.detail.artifacts, artifact);
  }

  /** A native background task is the durable integration intent and operation identity. */
  private async queueIntegration(tx: Tx, owned: Scope): Promise<Integration> {
    if (!owned.task.artifactId || !owned.run.integrationArtifactId || !this.inputsCurrent(owned))
      throw new Error("Task has no current retained code to integrate");
    const existing = owned.detail.integrations.find((item) => item.id === owned.task.integrationId);
    if (existing?.status === "pending") return existing;
    const native = await tx.createTask(
      this.integrationJob,
      { runId: owned.run.id, id: owned.task.id },
      {
        ownership: { kind: "conversation" },
        conversationId: nativeConversation(owned.run.id),
        background: true,
      },
    );
    const integration: Integration = {
      id: String(native),
      runId: owned.run.id,
      taskId: owned.task.id,
      revision: owned.task.revision,
      resultArtifactId: owned.task.artifactId,
      baseArtifactId: owned.run.integrationArtifactId,
      artifactId: null,
      status: "pending",
      conflicts: [],
      error: null,
      created: new Date().toISOString(),
    };
    owned.detail.integrations.push(integration);
    replace(owned.detail.tasks, {
      ...owned.task,
      integrationId: integration.id,
      status: "submitted",
      verificationId: null,
    });
    owned.detail.run.acceptedArtifactId = null;
    await event(
      tx,
      owned.run,
      "integration_queued",
      { integrationId: integration.id, resultArtifactId: integration.resultArtifactId },
      owned.task.id,
      owned.attempt.id,
    );
    return integration;
  }
  private integrationCurrent(detail: RunState, integration: Integration): boolean {
    const task = detail.tasks.find((item) => item.id === integration.taskId);
    return (
      detail.run.desired === "running" &&
      !!task &&
      task.revision === integration.revision &&
      task.integrationId === integration.id &&
      task.artifactId === integration.resultArtifactId &&
      !["superseded", "cancelled", "failed"].includes(task.status) &&
      this.inputsCurrent({
        detail,
        run: detail.run,
        task,
        attempt: detail.attempts.find((item) => item.id === task.currentAttemptId)!,
      })
    );
  }
  private async integrateResult(
    input: ResultInput,
    id: string,
    runtime: TaskRuntime<ResultInput, { phase: "integrate" }, null, object>,
    context: Context,
  ): Promise<void> {
    await this.waitFor(
      input.runId,
      (state) => {
        const detail = locate(state, input.runId),
          integration = detail.integrations.find((item) => item.id === id);
        return (
          !integration ||
          !this.integrationCurrent(detail, integration) ||
          (!state.applyOwner && (!state.integrationOwner || state.integrationOwner === id))
        );
      },
      runtime.signal,
      context,
    );
    let eligible = false;
    await runtime.commit(async (tx) => {
      const state = await draft(tx, input.runId),
        detail = locate(state, input.runId),
        integration = detail.integrations.find((item) => item.id === id);
      if (!integration || !this.integrationCurrent(detail, integration)) {
        if (integration) replace(detail.integrations, { ...integration, status: "stale" });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }
      if (state.applyOwner) throw new Error("Accepted tree is being applied");
      const owner = state.integrationOwner;
      if (owner && owner !== id) throw new Error("Integration ownership changed");
      if (!owner) {
        state.integrationOwner = id;
        replace(detail.integrations, { ...integration, baseArtifactId: detail.run.integrationArtifactId! });
      }
      eligible = true;
      return { status: "running", checkpoint: { phase: "integrate" } };
    }, context);
    if (!eligible) return;
    const state = await this.state(input.runId, context),
      detail = locate(state, input.runId),
      integration = detail.integrations.find((item) => item.id === id)!;
    const base = detail.artifacts.find((item) => item.id === integration.baseArtifactId),
      result = detail.artifacts.find((item) => item.id === integration.resultArtifactId);
    if (!base || !result) throw new Error("Integration input bytes are unavailable");
    let merged: Awaited<ReturnType<Workspaces["integrate"]>>;
    try {
      merged = await this.workspaces.integrate(detail.run, base, result, id, runtime.signal);
    } catch (error) {
      if (this.closing) throw error;
      await runtime.commit(async (tx) => {
        const state = await draft(tx, input.runId),
          detail = locate(state, input.runId),
          current = detail.integrations.find((item) => item.id === id)!;
        replace(detail.integrations, { ...current, status: "failed", error: String(error) });
        if (state.integrationOwner === id) state.integrationOwner = null;
        if (this.integrationCurrent(detail, current)) {
          const owned = taskScope(state, current.taskId);
          if (owned.task.parentTaskId)
            await this.queueDelivery(
              tx,
              owned,
              owned.task.parentTaskId,
              null,
              `Integration ${id} failed for task ${owned.task.id} revision ${owned.task.revision}: ${String(error)}`,
            );
        }
        await event(
          tx,
          detail.run,
          "integration_failed",
          { integrationId: id, error: String(error) },
          current.taskId,
        );
        return { status: "terminal", outcome: { status: "failed", error: { message: String(error) } } };
      }, context);
      return;
    }
    await runtime.commit(async (tx) => {
      const state = await draft(tx, input.runId),
        detail = locate(state, input.runId),
        current = detail.integrations.find((item) => item.id === id)!,
        owned = taskScope(state, current.taskId);
      if (state.integrationOwner !== id) {
        replace(detail.integrations, { ...current, status: "stale" });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }
      state.integrationOwner = null;
      if (merged.artifact) this.retain(owned, merged.artifact);
      if (
        !this.integrationCurrent(detail, current) ||
        detail.run.integrationArtifactId !== current.baseArtifactId
      ) {
        replace(detail.integrations, { ...current, status: "stale" });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }
      if (!merged.artifact) {
        replace(detail.integrations, {
          ...current,
          status: "conflicted",
          conflicts: [...(merged.conflicts ?? [])],
        });
        replace(detail.tasks, { ...owned.task, status: "conflicted" });
        if (owned.task.parentTaskId)
          await this.queueDelivery(
            tx,
            owned,
            owned.task.parentTaskId,
            owned.task.id,
            `Integration ${id} conflicted for task ${owned.task.id} revision ${owned.task.revision}. Conflicting paths: ${(merged.conflicts ?? []).join(", ")}. Inspect the task and request a revision.`,
          );
        await event(
          tx,
          detail.run,
          "integration_conflicted",
          { integrationId: id, conflicts: [...(merged.conflicts ?? [])] },
          owned.task.id,
        );
      } else {
        if (merged.artifact.kind !== "integration" || merged.artifact.base !== base.head)
          throw new Error("Integrated artifact does not match its pinned base");
        replace(detail.integrations, { ...current, status: "integrated", artifactId: merged.artifact.id });
        detail.run.integrationArtifactId = merged.artifact.id;
        detail.run.acceptedArtifactId = null;
        // Every check is evidence for an exact tree. An additive contribution changes that tree too.
        for (const verification of detail.verifications)
          if (!["stale", "cancelled"].includes(verification.status))
            replace(detail.verifications, { ...verification, status: "stale" });
        for (const task of [...detail.tasks]) {
          const applied = detail.integrations.find((item) => item.id === task.integrationId);
          if (applied?.status === "integrated" && this.integrationCurrent(detail, applied)) {
            replace(detail.tasks, { ...task, status: "submitted", verificationId: null });
            await this.queueVerification(tx, taskScope(state, task.id), merged.artifact);
          }
        }
        await event(
          tx,
          detail.run,
          "result_integrated",
          { integrationId: id, artifactId: merged.artifact.id, tree: merged.artifact.tree },
          owned.task.id,
        );
      }
      this.acceptance(detail);
      return { status: "terminal", outcome: { status: "completed", result: null } };
    }, context);
  }
  private async abortIntegration(
    input: ResultInput,
    id: string,
    runtime: TaskRuntime<ResultInput, { phase: "integrate" }, null, object>,
    context: Context,
  ): Promise<void> {
    await runtime.commit(async (tx) => {
      const state = await draft(tx, input.runId),
        detail = locate(state, input.runId),
        integration = detail.integrations.find((item) => item.id === id);
      if (integration && integration.status === "pending")
        replace(detail.integrations, { ...integration, status: "stale" });
      if (state.integrationOwner === id) state.integrationOwner = null;
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  }
  private async queueVerification(tx: Tx, owned: Scope, artifact: Artifact): Promise<Verification | null> {
    const writer = this.role(owned),
      policy = writer.verification;
    if (!policy) return null;
    const verifier = owned.run.catalog?.agents[policy.agent];
    if (!verifier) throw new Error("Frozen verification agent is missing");
    const policyDigest = digest({ policy, agent: verifier });
    const old = owned.detail.verifications.find(
      (item) =>
        item.taskId === owned.task.id &&
        item.revision === owned.task.revision &&
        item.artifactId === artifact.id &&
        item.policyDigest === policyDigest &&
        ["pending", "running", "passed"].includes(item.status),
    );
    if (old) {
      replace(owned.detail.tasks, {
        ...owned.task,
        verificationId: old.id,
        status: old.status === "passed" ? "accepted" : "verifying",
      });
      return old;
    }
    const native = await tx.createTask(
      this.verificationJob,
      { runId: owned.run.id, id: owned.task.id },
      {
        ownership: { kind: "conversation" },
        conversationId: nativeConversation(owned.run.id),
        background: true,
      },
    );
    const verification: Verification = {
      id: String(native),
      runId: owned.run.id,
      taskId: owned.task.id,
      revision: owned.task.revision,
      integrationId: owned.task.integrationId!,
      artifactId: artifact.id,
      tree: artifact.tree,
      agent: copyJson(verifier) as JsonRepresentation<AgentDefinition>,
      policy: copyJson(policy) as JsonRepresentation<VerificationPolicy>,
      policyDigest,
      status: "pending",
      checks: [],
      execution: null,
      error: null,
      created: new Date().toISOString(),
      completed: null,
    };
    owned.detail.verifications.push(verification);
    replace(owned.detail.tasks, { ...owned.task, verificationId: String(native), status: "verifying" });
    await event(
      tx,
      owned.run,
      "verification_queued",
      { verificationId: String(native), artifactId: artifact.id, policyDigest },
      owned.task.id,
    );
    return verification;
  }
  private verificationCurrent(detail: RunState, verification: Verification): boolean {
    const task = detail.tasks.find((item) => item.id === verification.taskId),
      integration = detail.integrations.find((item) => item.id === verification.integrationId);
    return (
      !!task &&
      !!integration &&
      this.integrationCurrent(detail, integration) &&
      task.verificationId === verification.id &&
      task.revision === verification.revision &&
      detail.run.integrationArtifactId === verification.artifactId &&
      !["stale", "cancelled"].includes(verification.status)
    );
  }
  private async verifyResult(
    input: ResultInput,
    id: string,
    checkpoint: VerificationCheckpoint,
    runtime: TaskRuntime<ResultInput, VerifyState, null, object>,
    context: Context,
  ): Promise<void> {
    const state = await this.state(input.runId, context),
      detail = locate(state, input.runId),
      verification = detail.verifications.find((item) => item.id === id);
    if (!verification) throw new Error("Verification intent is missing");
    if (!this.verificationCurrent(detail, verification)) {
      await this.abortVerification(input, runtime, context, checkpoint);
      return;
    }
    const artifact = detail.artifacts.find((item) => item.id === verification.artifactId);
    if (!artifact || artifact.tree !== verification.tree)
      throw new Error("Verification tree binding changed");
    if (verification.status === "pending") {
      let admitted = false;
      await runtime.commit(async (tx) => {
        const detail = locate(await draft(tx, input.runId), input.runId),
          current = detail.verifications.find((item) => item.id === id)!;
        const live =
          detail.attempts.filter(
            (attempt) =>
              attempt.desired === "running" && !["queued", "stopped", "failed"].includes(attempt.status),
          ).length +
          detail.verifications.filter((item) => item.id !== id && item.status === "running").length;
        if (live >= detail.run.limits.maxLiveAttempts)
          return {
            status: "sleeping",
            until: Date.now() + 1000,
            checkpoint: { phase: "run", journal: checkpoint },
          };
        replace(detail.verifications, { ...current, status: "running" });
        admitted = true;
        return { status: "running", checkpoint: { phase: "run", journal: checkpoint } };
      }, context);
      if (!admitted) return;
    }

    let journal = checkpoint;
    const alive = async () => {
      if (this.closing) return false;
      const detail = locate(await this.state(input.runId), input.runId),
        current = detail.verifications.find((item) => item.id === id);
      return !!current && this.verificationCurrent(detail, current);
    };
    let result: Awaited<ReturnType<Verifier["run"]>>;
    try {
      result = await this.verifier.run(
        detail.run,
        verification,
        artifact,
        {
          load: async () => journal,
          save: async (next) => {
            await runtime.commit(async (tx) => {
              const state = await draft(tx, input.runId),
                detail = locate(state, input.runId),
                current = detail.verifications.find((item) => item.id === id)!;
              if (
                current.execution &&
                next.execution &&
                canonical(current.execution) !== canonical(next.execution)
              )
                throw new Error("Verification execution identity changed");
              replace(detail.verifications, {
                ...current,
                execution: next.execution ?? current.execution,
                status: this.verificationCurrent(detail, current) ? "running" : "stale",
              });
              return { status: "running", checkpoint: { phase: "run", journal: next } };
            }, context);
            journal = next;
          },
        },
        alive,
        () => this.closing,
        runtime.signal,
      );
    } catch (error) {
      if (this.closing || runtime.signal.aborted) throw error;
      if (error instanceof BayError && error.code === "capacity_exhausted" && !journal.dispatched) {
        await runtime.commit(async (tx) => {
          const detail = locate(await draft(tx, input.runId), input.runId),
            current = detail.verifications.find((item) => item.id === id)!;
          replace(detail.verifications, { ...current, status: "pending" });
          return { status: "sleeping", until: Date.now() + 1000, checkpoint: { phase: "run", journal } };
        }, context);
        return;
      }
      await runtime.commit(async (tx) => {
        const state = await draft(tx, input.runId),
          detail = locate(state, input.runId),
          current = detail.verifications.find((item) => item.id === id)!;
        const valid = this.verificationCurrent(detail, current);
        replace(detail.verifications, {
          ...current,
          status: valid ? "failed" : "stale",
          error: String(error),
          completed: new Date().toISOString(),
        });
        if (valid) {
          const owned = taskScope(state, current.taskId);
          replace(detail.tasks, { ...owned.task, status: "submitted" });
          if (owned.task.parentTaskId)
            await this.queueDelivery(
              tx,
              owned,
              owned.task.parentTaskId,
              null,
              `Independent verification ${id} failed for task ${owned.task.id} revision ${owned.task.revision}, artifact ${current.artifactId}, tree ${current.tree}: ${String(error)}`,
            );
        }
        this.acceptance(detail);
        await event(
          tx,
          detail.run,
          "verification_failed",
          { verificationId: id, error: String(error) },
          current.taskId,
        );
        return { status: "terminal", outcome: { status: "failed", error: { message: String(error) } } };
      }, context);
      return;
    }
    await runtime.commit(async (tx) => {
      const state = await draft(tx, input.runId),
        detail = locate(state, input.runId),
        current = detail.verifications.find((item) => item.id === id)!;
      const names = Object.keys(current.policy.checks),
        received = result.checks.map((item) => item.name),
        complete =
          received.length === names.length &&
          new Set(received).size === names.length &&
          names.every((name) => received.includes(name));
      const passed =
        complete &&
        result.checks.every((check) => check.status === "passed" && check.exitCode === 0) &&
        canonical(current.execution) === canonical(result.verificationExecution);
      const valid = this.verificationCurrent(detail, current),
        checks = result.checks.map((check) => ({
          ...check,
          output: Buffer.from(check.output).subarray(0, 65536).toString("utf8"),
          ...(Buffer.byteLength(check.output) > 65536 ? { truncated: true } : {}),
        }));
      replace(detail.verifications, {
        ...current,
        status: valid ? (passed ? "passed" : "failed") : "stale",
        checks,
        completed: new Date().toISOString(),
        error: passed ? null : "Independent checks did not all pass for the retained tree",
      });
      if (valid) {
        const owned = taskScope(state, current.taskId);
        replace(detail.tasks, { ...owned.task, status: passed ? "accepted" : "submitted" });
        if (owned.task.parentTaskId)
          await this.queueDelivery(
            tx,
            owned,
            owned.task.parentTaskId,
            null,
            `Independent verification ${id} ${passed ? "passed" : "failed"} for task ${owned.task.id} revision ${owned.task.revision}, artifact ${current.artifactId}, tree ${current.tree}.`,
          );
      }
      this.acceptance(detail);
      await event(
        tx,
        detail.run,
        valid && passed ? "verification_passed" : "verification_failed",
        { verificationId: id, artifactId: current.artifactId, tree: current.tree },
        current.taskId,
      );
      return { status: "terminal", outcome: { status: "completed", result: null } };
    }, context);
  }
  private async abortVerification(
    input: ResultInput,
    runtime: TaskRuntime<ResultInput, VerifyState, null, object>,
    context: Context,
    checkpoint: VerificationCheckpoint,
  ): Promise<void> {
    const detail = locate(await this.state(input.runId, context), input.runId),
      verification = detail.verifications.find((item) => item.id === String(runtime.taskId));
    let execution = verification?.execution;
    if (verification && !execution && checkpoint.dispatched && !this.closing) {
      const name = baySessionName(this.namespace, "verify", verification.id),
        bay = new Bay(detail.run.catalog!.baySocket, AbortSignal.timeout(10_000));
      let session: Awaited<ReturnType<Bay["get"]>>;
      try {
        session = await bay.get(name);
      } catch (error) {
        // A dispatched POST can still allocate after a 404. Keep cleanup unresolved, never create again.
        if (error instanceof BayError && error.status === 404)
          throw new Error("Verification launch outcome is unknown; cleanup requires reconciliation");
        throw error;
      }
      assertBaySession(session, { name, agent: verification.agent, generation: 1 });
      execution = { sessionName: name, recordId: session.id, generation: session.generation };
      const pinned = execution;
      await this.harness.commit(async (tx) => {
        const detail = locate(await draft(tx, input.runId), input.runId),
          current = detail.verifications.find((item) => item.id === verification.id)!;
        if (current.execution && canonical(current.execution) !== canonical(pinned))
          throw new Error("Verification execution identity changed during cleanup");
        replace(detail.verifications, { ...current, execution: pinned });
      }, context);
    }
    if (execution && !this.closing) {
      const e = execution;
      await new Bay(detail.run.catalog!.baySocket, AbortSignal.timeout(10_000)).suspend(
        e.sessionName,
        e.recordId,
        e.generation,
      );
    }
    await runtime.commit(async (tx) => {
      const detail = locate(await draft(tx, input.runId), input.runId),
        current = detail.verifications.find((item) => item.id === String(runtime.taskId));
      if (current)
        replace(detail.verifications, {
          ...current,
          status: "cancelled",
          error: null,
          completed: new Date().toISOString(),
        });
      this.acceptance(detail);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  }
  private acceptance(detail: RunState): void {
    const { run } = detail;
    run.acceptedArtifactId = null;
    if (
      run.desired !== "running" ||
      !run.integrationArtifactId ||
      run.integrationArtifactId === run.inputArtifactId ||
      detail.questions.some((item) => item.status === "open")
    )
      return;
    const required = detail.tasks.filter(
      (task) => task.status !== "superseded" && task.status !== "cancelled",
    );
    if (
      !required.some((task) => task.id === run.rootTaskId) ||
      required.some(
        (task) =>
          !task.reportId || (task.artifactId ? task.status !== "accepted" : task.status !== "submitted"),
      )
    )
      return;
    if (
      required
        .filter((task) => task.artifactId)
        .every((task) => {
          const verification = detail.verifications.find((item) => item.id === task.verificationId);
          return (
            verification?.status === "passed" &&
            verification.artifactId === run.integrationArtifactId &&
            this.verificationCurrent(detail, verification)
          );
        })
    )
      run.acceptedArtifactId = run.integrationArtifactId;
  }
  /** Invalidation follows both declared dependencies and integrated input provenance. */
  private invalidate(detail: RunState, root: string): Set<string> {
    const stale = new Set([root]),
      ownership = new Set([root]);
    let changed = true;
    while (changed) {
      changed = false;
      const artifacts = new Set(
        detail.integrations
          .filter((item) => stale.has(item.taskId) && item.status === "integrated")
          .map((item) => item.artifactId)
          .filter((id): id is string => !!id),
      );
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of detail.integrations)
          if (item.artifactId && artifacts.has(item.baseArtifactId) && !artifacts.has(item.artifactId)) {
            artifacts.add(item.artifactId);
            expanded = true;
          }
      }
      for (const task of detail.tasks) {
        const inherited = Boolean(task.parentTaskId && ownership.has(task.parentTaskId)),
          consumed =
            task.dependencies.some((item) => stale.has(item.taskId)) ||
            Boolean(task.inputArtifactId && artifacts.has(task.inputArtifactId));
        if (inherited || consumed) {
          if (!stale.has(task.id)) {
            stale.add(task.id);
            changed = true;
          }
          if (!ownership.has(task.id)) {
            ownership.add(task.id);
            changed = true;
          }
        }
      }
      // Withdrawing an ancestor's completion revokes that actor too, but does not
      // withdraw independent sibling results merely because they share that parent.
      for (const id of [...stale]) {
        let parent = detail.tasks.find((item) => item.id === id)?.parentTaskId;
        while (parent) {
          const task = detail.tasks.find((item) => item.id === parent)!;
          if (task.reportId && !stale.has(parent)) {
            stale.add(parent);
            changed = true;
          }
          parent = task.parentTaskId;
        }
      }
    }
    return stale;
  }
  private revoke(detail: RunState, ids: readonly string[], status: "cancelled" | "superseded"): string[] {
    const targets = new Set(ids),
      abort: string[] = [];
    detail.run.acceptedArtifactId = null;
    for (const task of [...detail.tasks])
      if (targets.has(task.id)) {
        const attempt = detail.attempts.find((item) => item.id === task.currentAttemptId)!;
        replace(detail.attempts, {
          ...attempt,
          desired: "stopped",
          status: attempt.execution ? "stopping" : attempt.status === "queued" ? "stopped" : attempt.status,
        });
        if (
          status !== "cancelled" ||
          ["queued", "running", "waiting", "submitting", "verifying"].includes(task.status)
        )
          replace(detail.tasks, {
            ...task,
            status,
            reportId: null,
            artifactId: null,
            integrationId: null,
            verificationId: null,
            waitFor: [],
          });
        abort.push(attempt.id);
      }
    for (const item of detail.integrations)
      if (targets.has(item.taskId) && item.status === "pending") abort.push(item.id);
    for (const item of [...detail.verifications])
      if (
        targets.has(item.taskId) &&
        !["stale", "cancelled"].includes(item.status) &&
        (status === "superseded" || ["pending", "running"].includes(item.status))
      ) {
        if (["pending", "running"].includes(item.status)) abort.push(item.id);
        else
          replace(detail.verifications, { ...item, status: status === "cancelled" ? "cancelled" : "stale" });
      }
    for (const item of [...detail.questions])
      if (targets.has(item.taskId) && item.status === "open")
        replace(detail.questions, { ...item, status: "superseded" });
    return [...new Set(abort)];
  }
  private async rebuild(
    tx: Tx,
    state: DomainState,
    detail: RunState,
    stale: ReadonlySet<string>,
  ): Promise<void> {
    const changed = detail.integrations.some(
      (item) => stale.has(item.taskId) && item.status === "integrated",
    );
    if (!changed) return;
    detail.run.integrationArtifactId = detail.run.inputArtifactId;
    detail.run.acceptedArtifactId = null;
    // A running old merge cannot publish against this reset; its owner is relinquished here.
    state.integrationOwner = null;
    for (const item of [...detail.integrations])
      if (!["stale", "failed"].includes(item.status))
        replace(detail.integrations, { ...item, status: "stale" });
    for (const item of [...detail.verifications])
      if (!["stale", "cancelled"].includes(item.status))
        replace(detail.verifications, { ...item, status: "stale" });
    for (const task of [...detail.tasks])
      if (
        !stale.has(task.id) &&
        task.artifactId &&
        !["superseded", "failed", "cancelled"].includes(task.status)
      ) {
        const current = { ...task, integrationId: null, verificationId: null, status: "submitted" as const };
        replace(detail.tasks, current);
        await this.queueIntegration(tx, { ...taskScope(state, task.id), task: current });
      }
    await event(tx, detail.run, "integration_rebuilt", {
      inputArtifactId: detail.run.inputArtifactId,
      invalidated: [...stale],
    });
  }
}
