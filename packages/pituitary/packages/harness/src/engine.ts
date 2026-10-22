import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentCatalog } from "./catalog.ts";
import {
  type DomainCommand,
  type InboxMessage,
  validateDomainCommand,
  type WorkerAssignment,
} from "./domain-protocol.ts";
import { canonical } from "./protocol.ts";
import {
  type Attempt,
  DEFAULT_RUN_LIMITS,
  type Effect,
  type Run,
  type RunExecution,
  type RunLimits,
  type RunStore,
  socketDirectory,
  type Task,
} from "./store.ts";

export interface StartRunInput {
  name?: string;
  cwd: string;
  prompt?: string;
  agent?: string;
  repos?: readonly string[];
}
export interface EngineOptions {
  catalog?: AgentCatalog;
  bayCommand?: string;
  limits?: Partial<RunLimits>;
  now?: () => number;
}
export interface EffectOutcome {
  execution?: RunExecution;
  sessionId?: string;
  incarnation?: string;
  pid?: number | null;
  resolvedRepos?: readonly string[];
  status?: "ready" | "busy";
}
export type AttemptObservation = Partial<
  Pick<Attempt, "status" | "sessionId" | "incarnation" | "pid" | "error" | "execution">
>;
const LIVE = new Set<Attempt["status"]>([
  "starting",
  "ready",
  "busy",
  "waiting",
  "unreachable",
  "interrupted",
  "stopping",
]);

/** Deterministic decisions and transactions. The supervisor performs its concrete effects. */
export class Engine {
  private readonly now: () => number;
  constructor(
    readonly store: RunStore,
    private readonly options: EngineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  start(input: StartRunInput, id: string = randomUUID(), source = this.options.catalog): Run {
    return this.received("operator", id, input, () => {
      const cwd = realpathSync(input.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error("Working directory must be a directory");
      const runId = randomUUID(),
        taskId = randomUUID();
      const name = input.name ?? runId.slice(0, 8);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error("Invalid run name");
      if (this.store.findRun(name))
        throw new Error(`Run ${name} already exists; attach to it or choose another name`);
      const catalog = input.agent ? this.freezeCatalog(input.agent, source) : null;
      if (input.repos?.length && !catalog) throw new Error("--repo requires --agent");
      const limits = { ...DEFAULT_RUN_LIMITS, ...this.options.limits };
      for (const [key, value] of Object.entries(limits))
        if (!Number.isSafeInteger(value) || value < (key === "maxDepth" ? 0 : 1))
          throw new Error(`Invalid run limit ${key}`);
      const run: Run = {
        id: runId,
        name,
        cwd,
        objective: input.prompt ?? "",
        created: new Date(this.now()).toISOString(),
        desired: "running",
        rootTaskId: taskId,
        catalog,
        limits,
        deadline: this.now() + limits.deadlineMs,
        repos: [...(input.repos ?? [])],
      };
      this.store.putRun(run);
      const task = this.createTask(
        run,
        taskId,
        null,
        input.agent ?? null,
        run.objective,
        [],
        0,
        limits.maxDepth,
      );
      this.store.append(run.id, "run_created", { name, cwd }, task.id, task.currentAttemptId);
      return run;
    });
  }

  command(assignment: WorkerAssignment, id: string, input: DomainCommand): unknown {
    const command = validateDomainCommand(input);
    return this.received(`${assignment.attemptId}:${assignment.epoch}`, id, command, () => {
      const { run, task, attempt } = this.authorize(assignment);
      switch (command.type) {
        case "inspect": {
          const selected = command.taskId ? this.store.getTask(command.taskId) : task;
          if (selected.runId !== run.id) throw new Error("Task belongs to another run");
          const text = selected.report?.text;
          return {
            task: {
              id: selected.id,
              parentTaskId: selected.parentTaskId,
              role: selected.role,
              status: selected.status,
              waitingFor: selected.waitFor,
              objective: selected.objective.slice(0, 4096),
              acceptance: selected.acceptance.slice(0, 32).map((condition) => condition.slice(0, 4096)),
              ...(selected.report
                ? {
                    report: {
                      id: selected.report.id,
                      digest: selected.report.digest,
                      text: text?.slice(0, 16 * 1024),
                      truncated: (text?.length ?? 0) > 16 * 1024,
                    },
                  }
                : {}),
            },
            tasks: this.store.listTasks(run.id).map((item) => ({
              id: item.id,
              parentTaskId: item.parentTaskId,
              role: item.role,
              status: item.status,
              reportId: item.report?.id ?? null,
            })),
          };
        }
        case "delegate": {
          const definition = task.role ? run.catalog?.agents[task.role] : undefined;
          if (!definition?.manifest.delegatesTo.includes(command.agent))
            throw new Error("This role cannot delegate to that agent");
          if (attempt.grant.maxDepth < 1) throw new Error("Delegation depth limit reached");
          const tasks = this.store.listTasks(run.id);
          if (tasks.length >= run.limits.maxTasks) throw new Error("Run task limit reached");
          if (tasks.filter((child) => child.parentTaskId === task.id).length >= attempt.grant.maxChildren)
            throw new Error("Agent child limit reached");
          const child = this.createTask(
            run,
            randomUUID(),
            task.id,
            command.agent,
            command.objective,
            command.acceptance ?? [],
            attempt.depth + 1,
            attempt.grant.maxDepth - 1,
          );
          this.store.append(
            run.id,
            "task_delegated",
            { parentTaskId: task.id },
            child.id,
            child.currentAttemptId,
          );
          return { taskId: child.id, attemptId: child.currentAttemptId, status: "queued" };
        }
        case "message": {
          const target = this.recipient(run, task, command.to);
          if (
            attempt.execution.kind !== "bay" ||
            !attempt.execution.recordId ||
            attempt.execution.generation === null
          )
            throw new Error("This attempt has no authenticated Bay mailbox");
          if (target) {
            const recipient = this.store.getAttempt(target.currentAttemptId);
            if (recipient.execution.kind !== "bay") throw new Error("Recipient has no Bay mailbox");
            if (
              recipient.desired !== "running" ||
              ["submitted", "failed", "cancelled"].includes(target.status)
            )
              throw new Error("Recipient task no longer accepts messages");
          }
          if (command.replyTo) {
            const received = this.store
              .listEffects(run.id)
              .filter(
                (effect) =>
                  effect.kind === "deliver" &&
                  effect.attemptId === attempt.id &&
                  effect.state !== "cancelled",
              )
              .flatMap((effect) =>
                Array.isArray(effect.payload.messages) ? (effect.payload.messages as InboxMessage[]) : [],
              )
              .find((message) => message.id === command.replyTo);
            if (!received || (target ? received.taskId !== target.id : received.from !== "operator"))
              throw new Error("Reply must name an inbox message from this recipient");
          }
          const effect = this.enqueue(run, attempt, "send", {
            to: command.to,
            toTaskId: target?.id ?? null,
            body: command.body,
            ...(command.replyTo ? { replyTo: command.replyTo } : {}),
          });
          this.store.append(
            run.id,
            "message_queued",
            { messageId: effect.id, toTaskId: target?.id ?? null },
            task.id,
            attempt.id,
          );
          return { messageId: effect.id, status: "queued" };
        }
        case "yield":
          this.store.putTask({
            ...task,
            status: "waiting",
            waitFor: this.store
              .listTasks(run.id)
              .filter(
                (child) =>
                  child.parentTaskId === task.id &&
                  child.status !== "submitted" &&
                  child.status !== "cancelled",
              )
              .map((child) => child.id),
          });
          this.store.putAttempt({ ...attempt, status: "waiting" });
          this.store.append(run.id, "task_waiting", { reason: command.reason ?? null }, task.id, attempt.id);
          return { status: "waiting" };
        case "submit": {
          if (Buffer.byteLength(command.summary) > run.limits.reportBytes)
            throw new Error("Report exceeds the run byte limit");
          const report = {
            id: randomUUID(),
            attemptId: attempt.id,
            digest: createHash("sha256").update(command.summary).digest("hex"),
            text: command.summary,
            at: new Date(this.now()).toISOString(),
          };
          this.store.putTask({ ...task, status: "submitted", waitFor: [], report });
          this.store.putAttempt({ ...attempt, status: "waiting" });
          this.store.append(
            run.id,
            "report_submitted",
            { reportId: report.id, digest: report.digest },
            task.id,
            attempt.id,
          );
          if (task.parentTaskId) {
            const parent = this.store.getTask(task.parentTaskId);
            const excerpt = Buffer.from(command.summary)
              .subarray(0, 60 * 1024)
              .toString("utf8");
            const body = `Agent ${task.role ?? "local"} submitted unverified report ${report.id} for task ${task.id}.\n\n${excerpt}`;
            this.deliverInternal(
              run,
              this.store.getAttempt(parent.currentAttemptId),
              [{ id: report.id, from: "runtime", taskId: task.id, body }],
              `report-${report.id}`,
            );
          }
          return { reportId: report.id, digest: report.digest, status: "submitted" };
        }
      }
    });
  }

  stop(name: string, id: string = randomUUID()): Run {
    return this.received("operator", id, { type: "stop", name }, () =>
      this.stopRun(this.store.getRun(name), "stop_requested"),
    );
  }

  recover(name: string, id: string = randomUUID()): Run {
    return this.received("operator", id, { type: "recover", name }, () => {
      const run = this.store.getRun(name);
      if (run.desired !== "running") throw new Error("Stopped runs cannot be recovered");
      for (const task of this.store.listTasks(run.id)) {
        const attempt = this.store.getAttempt(task.currentAttemptId);
        if (
          attempt.desired !== "running" ||
          ["stopped", "failed", "interrupted", "queued"].includes(attempt.status)
        )
          continue;
        const effects = this.store.listEffects(run.id).filter((effect) => effect.attemptId === attempt.id);
        for (const effect of effects)
          if (effect.state === "uncertain" && ["reconnect", "prompt"].includes(effect.kind))
            this.store.putEffect({ ...effect, state: "pending", notBefore: 0 });
        if (
          !this.store
            .listEffects(run.id)
            .some(
              (effect) =>
                effect.attemptId === attempt.id &&
                effect.kind === "reconnect" &&
                ["pending", "dispatching"].includes(effect.state),
            )
        )
          this.enqueue(run, attempt, "reconnect", {});
      }
      return run;
    });
  }

  /** Receives already authenticated Bay mail. Its stable ID deduplicates durable delivery. */
  deliver(attemptId: string, messages: InboxMessage[], id: string): void {
    this.received("inbox", id, { attemptId, messages }, () => {
      const attempt = this.store.getAttempt(attemptId),
        task = this.store.getTask(attempt.taskId),
        run = this.store.getRun(task.runId);
      if (
        attempt.desired !== "running" ||
        task.currentAttemptId !== attempt.id ||
        run.desired !== "running" ||
        task.status === "submitted"
      )
        return null;
      this.deliverInternal(run, attempt, messages, id);
      return null;
    });
  }

  claimEffect(): Effect | null {
    return this.store.transaction(() => {
      for (const run of this.store.listRuns())
        if (run.desired === "running" && this.now() >= run.deadline) this.stopRun(run, "deadline_reached");
      const effects = this.store
        .listEffects()
        .filter((effect) => effect.state === "pending" && effect.notBefore <= this.now());
      effects.sort((a, b) => Number(b.kind === "stop") - Number(a.kind === "stop"));
      for (const effect of effects) {
        const attempt = this.store.getAttempt(effect.attemptId),
          task = this.store.getTask(attempt.taskId),
          run = this.store.getRun(task.runId);
        if (
          effect.epoch !== attempt.epoch ||
          (effect.kind !== "stop" && (run.desired !== "running" || attempt.desired !== "running"))
        ) {
          this.store.putEffect({ ...effect, state: "cancelled" });
          continue;
        }
        if (effect.kind === "launch") {
          const taskIds = new Set(this.store.listTasks(run.id).map((item) => item.id));
          const live = this.store
            .listAttempts()
            .filter(
              (item) => item.id !== attempt.id && taskIds.has(item.taskId) && LIVE.has(item.status),
            ).length;
          if (live >= run.limits.maxLiveAttempts) {
            const error = `Waiting for run capacity: ${live} of ${run.limits.maxLiveAttempts} live attempts`;
            if (attempt.error !== error) {
              this.store.putAttempt({ ...attempt, error });
              this.store.append(run.id, "admission_waiting", { error }, task.id, attempt.id);
            }
            continue;
          }
          this.store.putAttempt({ ...attempt, status: "starting", error: null });
        } else if (
          ["prompt", "deliver", "send"].includes(effect.kind) &&
          ["queued", "starting", "unreachable"].includes(attempt.status)
        )
          continue;
        if (effect.kind === "prompt") this.store.putAttempt({ ...attempt, promptStatus: "dispatching" });
        const claimed: Effect = { ...effect, state: "dispatching", tries: effect.tries + 1 };
        this.store.putEffect(claimed);
        return claimed;
      }
      return null;
    });
  }

  ackEffect(id: string, outcome: EffectOutcome = {}): void {
    this.store.transaction(() => {
      const effect = this.store.getEffect(id);
      if (effect.state === "done") return;
      const attempt = this.store.getAttempt(effect.attemptId),
        task = this.store.getTask(attempt.taskId),
        run = this.store.getRun(task.runId);
      if (effect.state === "cancelled" && effect.kind !== "launch" && effect.kind !== "reconnect") return;
      this.store.putEffect({ ...effect, state: "done", error: null });
      if (effect.epoch !== attempt.epoch) {
        // Cancellation may finish before an already dispatched launch. Retain its exact
        // identity and schedule cleanup even when the earlier stop found no guest yet.
        if ((effect.kind === "launch" || effect.kind === "reconnect") && outcome.execution) {
          const stopping = { ...attempt, execution: outcome.execution, status: "stopping" as const };
          this.store.putAttempt(stopping);
          this.stopEffect(run, stopping);
        }
        return;
      }
      if (effect.kind === "launch" || effect.kind === "reconnect") {
        if (attempt.desired !== "running" || run.desired !== "running") return;
        if (this.identityChanged(attempt, outcome)) {
          this.interrupt(run, task, attempt);
          return;
        }
        const updated: Attempt = {
          ...attempt,
          execution: outcome.execution ?? attempt.execution,
          sessionId: outcome.sessionId ?? attempt.sessionId,
          incarnation: outcome.incarnation ?? attempt.incarnation,
          pid: outcome.pid ?? attempt.pid,
          status: outcome.status ?? "ready",
          error: null,
        };
        this.store.putAttempt(updated);
        if (outcome.resolvedRepos && task.parentTaskId === null)
          this.store.putRun({ ...run, repos: [...outcome.resolvedRepos] });
        if (task.status === "queued") this.store.putTask({ ...task, status: "running" });
        if (attempt.promptStatus === "pending")
          this.enqueue(
            run,
            updated,
            "prompt",
            { message: this.taskPrompt(task, this.store.getRun(run.id)) },
            `${attempt.id}:initial`,
          );
        this.store.append(run.id, "worker_ready", {}, task.id, attempt.id);
      } else if (effect.kind === "prompt") {
        this.store.putAttempt({ ...attempt, promptStatus: "accepted", error: null });
        this.store.append(run.id, "prompt_accepted", {}, task.id, attempt.id);
      } else if (effect.kind === "deliver") {
        if (task.status === "waiting") this.store.putTask({ ...task, status: "running", waitFor: [] });
        this.store.append(
          run.id,
          "messages_delivered",
          { batchId: effect.payload.batchId },
          task.id,
          attempt.id,
        );
      } else if (effect.kind === "stop") {
        this.store.putAttempt({ ...attempt, status: "stopped", error: null });
        this.store.append(run.id, "worker_stopped", {}, task.id, attempt.id);
      } else this.store.append(run.id, "message_sent", { messageId: effect.id }, task.id, attempt.id);
    });
  }

  failEffect(id: string, error: string, options: { retryable?: boolean; terminal?: boolean } = {}): void {
    this.store.transaction(() => {
      const effect = this.store.getEffect(id);
      if (effect.state === "done" || effect.state === "cancelled") return;
      const attempt = this.store.getAttempt(effect.attemptId),
        task = this.store.getTask(attempt.taskId);
      if (options.terminal) {
        this.store.putEffect({ ...effect, state: "failed", error });
        if (effect.epoch === attempt.epoch)
          this.failAttempt(this.store.getRun(task.runId), task, attempt, error, "failed");
        return;
      }
      const kind = effect.kind === "launch" ? "reconnect" : effect.kind;
      this.store.putEffect({
        ...effect,
        kind,
        state: options.retryable ? "pending" : "uncertain",
        notBefore: this.now() + Math.min(30_000, 250 * 2 ** Math.min(effect.tries, 7)),
        error,
      });
      if (effect.epoch !== attempt.epoch) return;
      if (["launch", "reconnect", "prompt", "stop"].includes(effect.kind))
        this.store.putAttempt({
          ...attempt,
          status: effect.kind === "stop" ? "stopping" : "unreachable",
          error,
          ...(effect.kind === "prompt" ? { promptStatus: "uncertain" as const } : {}),
        });
      this.store.append(
        task.runId,
        "effect_uncertain",
        { effectId: id, kind: effect.kind, error },
        task.id,
        attempt.id,
      );
    });
  }

  /** Capacity and busy responses are waiting conditions, not lost worker connections. */
  deferEffect(id: string, reason: string, delay = 250): void {
    this.store.transaction(() => {
      const effect = this.store.getEffect(id);
      if (effect.state === "done" || effect.state === "cancelled") return;
      if (effect.kind === "launch") {
        const attempt = this.store.getAttempt(effect.attemptId);
        if (attempt.desired === "running" && attempt.status === "starting")
          this.store.putAttempt({ ...attempt, status: "queued" });
      }
      this.store.putEffect({
        ...effect,
        state: "pending",
        notBefore: this.now() + Math.max(1, delay),
        error: reason,
      });
    });
  }

  observeAttempt(id: string, changes: AttemptObservation, type = "worker_observed"): Attempt {
    return this.store.transaction(() => {
      const attempt = this.store.getAttempt(id),
        task = this.store.getTask(attempt.taskId),
        run = this.store.getRun(task.runId);
      if (attempt.desired !== "running" || task.currentAttemptId !== attempt.id) return attempt;
      if (this.identityChanged(attempt, changes)) return this.interrupt(run, task, attempt);
      const updated = { ...attempt, ...changes };
      this.store.putAttempt(updated);
      this.store.append(run.id, type, changes, task.id, attempt.id);
      if (
        changes.status === "unreachable" &&
        !this.store
          .listEffects(run.id)
          .some(
            (effect) =>
              effect.attemptId === id &&
              ["launch", "reconnect"].includes(effect.kind) &&
              ["pending", "dispatching"].includes(effect.state),
          )
      )
        this.enqueue(run, updated, "reconnect", {});
      if (task.status === "submitted" && changes.status === "ready") {
        const stopping = {
          ...updated,
          desired: "stopped" as const,
          epoch: updated.epoch + 1,
          status: "stopping" as const,
        };
        this.store.putAttempt(stopping);
        this.stopEffect(run, stopping);
        return stopping;
      }
      return updated;
    });
  }

  interruptAttempt(
    id: string,
    reason = "Worker execution identity changed; a new attempt is required",
  ): Attempt {
    return this.store.transaction(() => {
      const attempt = this.store.getAttempt(id),
        task = this.store.getTask(attempt.taskId);
      if (attempt.desired !== "running") return attempt;
      return this.failAttempt(this.store.getRun(task.runId), task, attempt, reason, "interrupted");
    });
  }

  /** Pin a launch receipt even when cancellation won the race. This never grants input authority. */
  recordExecution(id: string, execution: RunExecution, pid?: number | null): Attempt {
    return this.store.transaction(() => {
      const attempt = this.store.getAttempt(id),
        task = this.store.getTask(attempt.taskId),
        run = this.store.getRun(task.runId);
      if (this.identityChanged(attempt, { execution }))
        throw new Error("Execution receipt conflicts with the pinned attempt");
      const updated: Attempt = {
        ...attempt,
        execution,
        ...(pid !== undefined ? { pid } : {}),
        ...(attempt.desired === "stopped" ? { status: "stopping" as const } : {}),
      };
      this.store.putAttempt(updated);
      this.store.append(
        run.id,
        "execution_recorded",
        {
          kind: execution.kind,
          ...(execution.kind === "bay"
            ? { recordId: execution.recordId, generation: execution.generation }
            : {}),
          pid: updated.pid,
        },
        task.id,
        attempt.id,
      );
      if (updated.desired === "stopped" || run.desired === "stopped") this.stopEffect(run, updated);
      return updated;
    });
  }

  /** No uncertain launch can become another POST. Other effects retain stable receipt IDs. */
  recoverEffects(): void {
    this.store.transaction(() => {
      for (const effect of this.store.listEffects())
        if (effect.state === "dispatching" || (effect.kind === "stop" && effect.state === "uncertain"))
          this.store.putEffect({
            ...effect,
            kind: effect.kind === "launch" ? "reconnect" : effect.kind,
            state: "pending",
          });
      for (const attempt of this.store.listAttempts()) {
        const task = this.store.getTask(attempt.taskId),
          run = this.store.getRun(task.runId);
        if (run.desired === "running" && attempt.desired === "running" && LIVE.has(attempt.status)) {
          this.store.putAttempt({ ...attempt, status: "unreachable" });
          if (
            !this.store
              .listEffects(run.id)
              .some(
                (effect) =>
                  effect.attemptId === attempt.id &&
                  ["launch", "reconnect"].includes(effect.kind) &&
                  ["pending", "dispatching"].includes(effect.state),
              )
          )
            this.enqueue(run, attempt, "reconnect", {});
        }
      }
      // A cancelled POST may outlive both an earlier absent-guest stop and this process.
      // Keep checking its deterministic environment after restart; absence alone does
      // not establish that a dispatched launch never happened.
      for (const effect of this.store.listEffects())
        if (effect.kind === "launch" && effect.state === "cancelled" && effect.tries > 0) {
          const attempt = this.store.getAttempt(effect.attemptId),
            run = this.store.getRun(effect.runId);
          const unstarted = this.store
            .listEffects(run.id)
            .some(
              (item) =>
                item.attemptId === attempt.id &&
                item.epoch === attempt.epoch &&
                item.kind === "stop" &&
                item.payload.unstarted === true,
            );
          if (attempt.desired === "stopped" && !unstarted) this.stopEffect(run, attempt);
        }
    });
  }

  private authorize(assignment: WorkerAssignment): { run: Run; task: Task; attempt: Attempt } {
    const attempt = this.store.getAttempt(assignment.attemptId),
      task = this.store.getTask(attempt.taskId),
      run = this.store.getRun(task.runId);
    if (!attempt.grant.orchestration) throw new Error("This attempt has no orchestration authority");
    if (
      assignment.runId !== run.id ||
      assignment.taskId !== task.id ||
      assignment.epoch !== attempt.epoch ||
      task.currentAttemptId !== attempt.id
    )
      throw new Error("Stale worker authority");
    if (
      run.desired !== "running" ||
      attempt.desired !== "running" ||
      task.status === "submitted" ||
      task.status === "cancelled" ||
      task.status === "failed"
    )
      throw new Error("Task no longer accepts commands");
    if (this.now() >= run.deadline) throw new Error("Run deadline reached");
    return { run, task, attempt };
  }
  private identityChanged(attempt: Attempt, changes: EffectOutcome | AttemptObservation): boolean {
    if (
      (attempt.incarnation && changes.incarnation && changes.incarnation !== attempt.incarnation) ||
      (attempt.sessionId && changes.sessionId && changes.sessionId !== attempt.sessionId)
    )
      return true;
    if (!changes.execution) return false;
    if (attempt.execution.kind !== changes.execution.kind) return true;
    if (attempt.execution.kind === "local" && changes.execution.kind === "local")
      return attempt.execution.socket !== changes.execution.socket;
    return (
      attempt.execution.kind === "bay" &&
      changes.execution.kind === "bay" &&
      ((attempt.execution.recordId !== null && changes.execution.recordId !== attempt.execution.recordId) ||
        (attempt.execution.generation !== null &&
          changes.execution.generation !== attempt.execution.generation) ||
        changes.execution.socket !== attempt.execution.socket ||
        changes.execution.sessionName !== attempt.execution.sessionName ||
        changes.execution.agent.program !== attempt.execution.agent.program ||
        changes.execution.agent.machine !== attempt.execution.agent.machine ||
        changes.execution.agent.machineRevision !== attempt.execution.agent.machineRevision)
    );
  }
  private interrupt(run: Run, task: Task, attempt: Attempt): Attempt {
    return this.failAttempt(
      run,
      task,
      attempt,
      "Worker execution identity changed; a new attempt is required",
      "interrupted",
    );
  }
  private failAttempt(
    run: Run,
    task: Task,
    attempt: Attempt,
    error: string,
    status: "interrupted" | "failed",
  ): Attempt {
    const interrupted: Attempt = {
      ...attempt,
      status,
      desired: "stopped",
      epoch: attempt.epoch + 1,
      error,
    };
    this.store.putAttempt(interrupted);
    this.store.putTask({ ...task, status: "failed" });
    this.store.append(run.id, "attempt_interrupted", { error: interrupted.error }, task.id, attempt.id);
    for (const effect of this.store.listEffects(run.id))
      if (effect.attemptId === attempt.id && ["pending", "dispatching"].includes(effect.state))
        this.store.putEffect({ ...effect, state: "cancelled" });
    if (status === "interrupted" || (attempt.execution.kind === "bay" && attempt.execution.recordId !== null))
      this.stopEffect(run, interrupted);
    if (task.parentTaskId) {
      const parent = this.store.getTask(task.parentTaskId);
      const id = `failure-${attempt.id}-${interrupted.epoch}`;
      this.deliverInternal(
        run,
        this.store.getAttempt(parent.currentAttemptId),
        [
          {
            id,
            from: "runtime",
            taskId: task.id,
            body: `Agent ${task.role ?? "local"} could not complete task ${task.id}: ${interrupted.error}. No result was accepted.`,
          },
        ],
        id,
      );
    } else {
      this.stopRun(run, "root_attempt_failed");
    }
    return this.store.getAttempt(attempt.id);
  }
  private taskPrompt(task: Task, run: Run): string {
    if (!task.role) return task.objective;
    return [
      `Task: ${task.id}`,
      ...(task.parentTaskId ? [`Parent task: ${task.parentTaskId} (message recipient: parent)`] : []),
      "",
      "Objective:",
      task.objective,
      ...(task.acceptance.length
        ? ["", "Acceptance conditions:", ...task.acceptance.map((condition) => `- ${condition}`)]
        : []),
      ...(run.repos.length ? ["", "Exact repository inputs:", ...run.repos.map((repo) => `- ${repo}`)] : []),
    ].join("\n");
  }
  private received<T>(principal: string, id: string, payload: unknown, operation: () => T): T {
    if (!id || id.length > 256) throw new Error("Invalid command ID");
    const encoded = canonical(payload);
    const receipt = this.store.transaction(
      (): { success: true; data: T } | { success: false; error: string } => {
        const existing = this.store.receipt(principal, id);
        if (existing) {
          if (existing.payload !== encoded)
            throw new Error("Command ID was already used with another payload");
          return existing.result as { success: true; data: T } | { success: false; error: string };
        }
        let result: { success: true; data: T } | { success: false; error: string };
        try {
          result = { success: true, data: this.store.transaction(operation) };
        } catch (error) {
          result = { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        this.store.putReceipt(principal, id, encoded, result);
        return result;
      },
    );
    if (!receipt.success) throw new Error(receipt.error);
    return receipt.data;
  }
  private freezeCatalog(root: string, source: AgentCatalog | undefined): AgentCatalog {
    if (!source?.agents[root]) throw new Error(`No declared agent named ${root}`);
    const agents: Record<string, AgentCatalog["agents"][string]> = Object.create(null);
    const visit = (name: string) => {
      if (Object.hasOwn(agents, name)) return;
      const definition = source.agents[name];
      if (!definition) throw new Error(`Undeclared delegation target ${name}`);
      agents[name] = structuredClone(definition);
      for (const target of definition.manifest.delegatesTo) visit(target);
    };
    visit(root);
    return { schemaVersion: 1, baySocket: source.baySocket, agents };
  }
  private createTask(
    run: Run,
    id: string,
    parentTaskId: string | null,
    role: string | null,
    objective: string,
    acceptance: readonly string[],
    depth: number,
    remainingDepth: number,
  ): Task {
    const attemptId = randomUUID();
    const definition = role ? run.catalog?.agents[role] : undefined;
    if (role && !definition) throw new Error(`No frozen declaration for ${role}`);
    const limits = definition?.manifest.limits ?? { maxChildren: 1, maxDepth: 1 };
    const task: Task = {
      id,
      runId: run.id,
      parentTaskId,
      role,
      objective,
      acceptance: [...acceptance],
      status: "queued",
      currentAttemptId: attemptId,
      waitFor: [],
      report: null,
    };
    const attempt: Attempt = {
      id: attemptId,
      taskId: id,
      number: 1,
      depth,
      directory: join(this.store.root, "runs", run.id, "attempts", attemptId),
      socket: join(socketDirectory(this.store.root), `${attemptId}.sock`),
      status: "queued",
      desired: "running",
      sessionId: null,
      incarnation: null,
      epoch: 1,
      pid: null,
      promptStatus: objective ? "pending" : null,
      error: null,
      grant: {
        orchestration: definition !== undefined,
        maxChildren: limits.maxChildren,
        maxDepth: Math.min(limits.maxDepth, remainingDepth, run.limits.maxDepth - depth),
      },
      execution:
        definition && run.catalog
          ? {
              kind: "bay",
              socket: run.catalog.baySocket,
              command: this.options.bayCommand ?? process.env.PITUITARY_BAY_COMMAND ?? "bay",
              sessionName: `pituitary-${attemptId}`,
              recordId: null,
              generation: null,
              agent: definition,
              repos: run.repos,
            }
          : { kind: "local", socket: join(socketDirectory(this.store.root), `${attemptId}.worker.sock`) },
    };
    this.store.putTask(task);
    this.store.putAttempt(attempt);
    this.enqueue(run, attempt, "launch", {});
    return task;
  }
  private enqueue(
    run: Run,
    attempt: Attempt,
    kind: Effect["kind"],
    payload: Record<string, unknown>,
    id: string = randomUUID(),
  ): Effect {
    const effect: Effect = {
      id,
      runId: run.id,
      attemptId: attempt.id,
      epoch: attempt.epoch,
      kind,
      payload,
      state: "pending",
      tries: 0,
      notBefore: 0,
      error: null,
    };
    if (!this.store.listEffects(run.id).some((existing) => existing.id === id)) this.store.putEffect(effect);
    return effect;
  }
  private deliverInternal(run: Run, attempt: Attempt, messages: InboxMessage[], id: string): void {
    if (attempt.desired !== "running") return;
    this.enqueue(run, attempt, "deliver", { type: "deliver", batchId: id, messages, wake: true }, id);
  }
  private stopEffect(run: Run, attempt: Attempt, unstarted = false): void {
    const existing = this.store
      .listEffects(run.id)
      .find(
        (effect) =>
          effect.attemptId === attempt.id &&
          effect.epoch === attempt.epoch &&
          effect.kind === "stop" &&
          ["pending", "dispatching", "uncertain"].includes(effect.state),
      );
    if (existing) {
      if (existing.payload.unstarted === true && !unstarted) {
        if (existing.state === "dispatching") {
          this.store.putEffect({ ...existing, state: "cancelled" });
          this.enqueue(run, attempt, "stop", {});
        } else this.store.putEffect({ ...existing, payload: {}, state: "pending", notBefore: 0 });
        return;
      }
      if (existing.state === "uncertain")
        this.store.putEffect({ ...existing, state: "pending", notBefore: 0 });
      return;
    }
    this.enqueue(run, attempt, "stop", unstarted ? { unstarted: true } : {});
  }
  private recipient(run: Run, task: Task, to: string): Task | null {
    if (to === "operator") return null;
    const id = to === "parent" ? task.parentTaskId : to;
    if (!id) throw new Error("This task has no parent");
    const target = this.store.getTask(id);
    if (target.runId !== run.id) throw new Error("Messages cannot address another run");
    return target;
  }
  private stopRun(run: Run, type: string): Run {
    if (run.desired === "stopped") {
      for (const effect of this.store.listEffects(run.id))
        if (effect.kind === "stop" && effect.state === "uncertain")
          this.store.putEffect({ ...effect, state: "pending", notBefore: 0 });
      return run;
    }
    const stopped = { ...run, desired: "stopped" as const };
    this.store.putRun(stopped);
    for (const task of this.store.listTasks(run.id)) {
      if (task.status !== "submitted" && task.status !== "failed")
        this.store.putTask({ ...task, status: "cancelled", waitFor: [] });
      const attempt = this.store.getAttempt(task.currentAttemptId);
      if (attempt.status === "stopped") continue;
      if (
        attempt.status === "failed" &&
        attempt.desired === "stopped" &&
        (attempt.execution.kind === "local" || attempt.execution.recordId === null)
      )
        continue;
      const updated =
        attempt.desired === "stopped"
          ? attempt
          : {
              ...attempt,
              desired: "stopped" as const,
              epoch: attempt.epoch + 1,
              status: "stopping" as const,
            };
      this.store.putAttempt(updated);
      this.stopEffect(run, updated, attempt.status === "queued");
    }
    for (const effect of this.store.listEffects(run.id))
      if (effect.kind !== "stop" && ["pending", "dispatching"].includes(effect.state))
        this.store.putEffect({ ...effect, state: "cancelled" });
    this.store.append(run.id, type);
    return stopped;
  }
}
