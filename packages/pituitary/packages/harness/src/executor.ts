import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBaySession, Bay, BayError } from "./bay.ts";
import type { WorkerAssignment } from "./domain-protocol.ts";
import type { EffectOutcome } from "./engine.ts";
import { agentManifestDigest } from "./protocol.ts";
import { type Attempt, privateDirectory, type Run, type RunExecution, type Task } from "./store.ts";
import { connectWorker, type WorkerClient } from "./worker-client.ts";

export interface ExecutionContext {
  run: Run;
  task: Task;
  attempt: Attempt;
}
export interface ConnectedWorker {
  client: WorkerClient;
  outcome: EffectOutcome;
}
export class ExecutionChanged extends Error {}
/** The executor proved that no process or machine was left running. */
export class ExecutionFailed extends Error {}
export interface ExecutionHooks {
  onCreated?(execution: RunExecution, pid?: number): void;
  onClient?(client: WorkerClient, context: ExecutionContext): void | Promise<void>;
}

export function assignmentFor({ run, task, attempt }: ExecutionContext): WorkerAssignment {
  return { runId: run.id, taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch };
}

/** Isolation and process lifecycle. Every launch decision has already been committed by Engine. */
export class Executor {
  constructor(
    private readonly workerCommand: readonly string[] = [
      process.execPath,
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
    ],
    private readonly startupTimeout = 15_000,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!workerCommand.length) throw new Error("Worker command must not be empty");
    if (!Number.isFinite(startupTimeout) || startupTimeout <= 0)
      throw new Error("Worker startup timeout must be positive");
  }

  async launch(context: ExecutionContext, hooks: ExecutionHooks = {}): Promise<ConnectedWorker> {
    const { run, attempt } = context;
    // Resolve the explicit profile before allocating a machine. Key bytes never enter saved intent.
    let keys: Record<string, string>;
    try {
      privateDirectory(attempt.directory);
      keys = this.credentials(context);
    } catch (error) {
      throw new ExecutionFailed(error instanceof Error ? error.message : String(error));
    }
    if (attempt.execution.kind === "bay") {
      const execution = attempt.execution;
      const session = await new Bay(execution.socket, execution.command, this.environment).start(
        execution.sessionName,
        execution.agent,
        execution.repos,
      );
      assertBaySession(session, { name: execution.sessionName, agent: execution.agent });
      const updated = {
        ...attempt,
        execution: { ...execution, recordId: session.id, generation: session.generation },
      };
      hooks.onCreated?.(updated.execution);
      const connected = await this.open({ ...context, attempt: updated }, keys, hooks);
      connected.outcome.resolvedRepos = (session.repos ?? []).map(
        (repo) => repo.owner + "/" + repo.name + "@" + repo.commit,
      );
      return connected;
    }
    let log: number;
    try {
      log = openSync(join(attempt.directory, "worker.log"), "a", 0o600);
    } catch (error) {
      throw new ExecutionFailed(error instanceof Error ? error.message : String(error));
    }
    let child: ChildProcess;
    try {
      child = spawn(
        this.workerCommand[0] as string,
        [
          ...this.workerCommand.slice(1),
          "--socket",
          attempt.execution.socket,
          "--state",
          attempt.directory,
          "--cwd",
          run.cwd,
        ],
        {
          detached: true,
          cwd: run.cwd,
          stdio: ["ignore", log, log],
          env: this.environment,
        },
      );
    } catch (error) {
      throw new ExecutionFailed(error instanceof Error ? error.message : String(error));
    } finally {
      closeSync(log);
    }
    let failure: Error | null = null;
    child.on("error", (error) => {
      failure = error;
    });
    child.unref();
    if (child.pid) hooks.onCreated?.(attempt.execution, child.pid);
    const deadline = Date.now() + this.startupTimeout;
    while (Date.now() < deadline) {
      if (failure) throw new ExecutionFailed((failure as Error).message);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new ExecutionFailed(
          "Worker exited before becoming ready; see " + join(attempt.directory, "worker.log"),
        );
      try {
        const connected = await this.open(context, keys, hooks, Math.max(1, deadline - Date.now()));
        connected.outcome.pid = child.pid ?? null;
        return connected;
      } catch (error) {
        if (error instanceof ExecutionChanged) {
          await terminate(child);
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await terminate(child);
    throw new ExecutionFailed("Worker startup timed out; see " + join(attempt.directory, "worker.log"));
  }

  /** Reconnection observes an existing execution and never creates a process or VM. */
  async reconnect(context: ExecutionContext, hooks: ExecutionHooks = {}): Promise<ConnectedWorker> {
    const attempt = context.attempt;
    if (attempt.execution.kind === "local") return this.open(context, this.credentials(context), hooks);
    const execution = attempt.execution;
    const session = await new Bay(execution.socket, execution.command, this.environment).get(
      execution.sessionName,
    );
    this.assertSession(session, execution, !attempt.grant.orchestration);
    if (session.state !== "running")
      throw new ExecutionChanged("Saved Bay execution is " + session.state + "; recovery cannot relaunch it");
    const updated = {
      ...attempt,
      execution: { ...execution, recordId: session.id, generation: session.generation },
    };
    hooks.onCreated?.(updated.execution);
    const connected = await this.open({ ...context, attempt: updated }, this.credentials(context), hooks);
    connected.outcome.resolvedRepos = (session.repos ?? []).map(
      (repo) => repo.owner + "/" + repo.name + "@" + repo.commit,
    );
    return connected;
  }

  async stop(context: ExecutionContext, existing?: WorkerClient): Promise<void> {
    const { attempt } = context;
    if (attempt.execution.kind === "bay") {
      const execution = attempt.execution;
      const bay = new Bay(execution.socket, execution.command, this.environment);
      let session: import("./bay.ts").BaySession;
      try {
        session = await bay.get(execution.sessionName);
      } catch (error) {
        if (error instanceof BayError && error.status === 404 && execution.recordId) {
          await existing?.close();
          return;
        }
        throw error;
      }
      this.assertSession(session, execution, !attempt.grant.orchestration);
      if (session.state === "running") {
        // A failed worker still has valuable files. Suspension retains them in every case.
        if (existing) await existing.request({ type: "shutdown" }, randomUUID(), 5000).catch(() => {});
        await bay.suspend(session.name, session.id, session.generation);
      }
      await existing?.close();
      return;
    }
    let client: WorkerClient;
    try {
      client = existing ?? (await connectWorker(attempt.execution.socket, { control: false }));
    } catch (error) {
      if (attempt.pid && !alive(attempt.pid)) return;
      throw error;
    }
    try {
      if (attempt.sessionId && client.identity.sessionId !== attempt.sessionId)
        throw new ExecutionChanged("Refusing to stop another native conversation");
      await client.request({ type: "shutdown" }, randomUUID(), 5000);
    } finally {
      await client.close();
    }
  }

  private async open(
    context: ExecutionContext,
    keys: Record<string, string>,
    hooks: ExecutionHooks,
    timeout = this.startupTimeout,
  ): Promise<ConnectedWorker> {
    const { run, task, attempt } = context;
    const execution = attempt.execution;
    const client =
      execution.kind === "local"
        ? await connectWorker(execution.socket, {
            control: true,
            supervisor: attempt.grant.orchestration,
            timeout: Math.min(1000, timeout),
          })
        : await new Bay(execution.socket, execution.command, this.environment).connect(
            execution.sessionName,
            execution.recordId as string,
            {
              generation: execution.generation as number,
              control: true,
              supervisor: attempt.grant.orchestration,
              timeout,
            },
          );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Worker initialization timed out"));
        void client.close();
      }, timeout);
    });
    try {
      return await Promise.race([
        expired,
        (async (): Promise<ConnectedWorker> => {
          if (attempt.incarnation && client.identity.incarnation !== attempt.incarnation)
            throw new ExecutionChanged("Worker incarnation changed; a new attempt is required");
          await hooks.onClient?.(client, context);
          if (execution.kind === "bay") {
            if (attempt.grant.orchestration) await client.provision(keys);
            else if (client.identity.assignment)
              throw new ExecutionChanged("This conversation is assigned to another orchestration attempt");
            const initialized = (await client.request({
              type: "initialize",
              manifest: execution.agent.manifest,
              ...(attempt.grant.orchestration ? { assignment: assignmentFor(context) } : {}),
            })) as { roleDigest: string };
            if (initialized.roleDigest !== agentManifestDigest(execution.agent.manifest))
              throw new ExecutionChanged("Worker role changed");
          }
          const state = await client.getState();
          if (attempt.sessionId && state.sessionId !== attempt.sessionId)
            throw new ExecutionChanged("Worker conversation changed; a new attempt is required");
          await client.request(
            {
              type: "set_session_name",
              name: task.parentTaskId ? run.name + "/" + (task.role ?? task.id.slice(0, 8)) : run.name,
            },
            attempt.id + ":name",
          );
          return {
            client,
            outcome: {
              execution,
              sessionId: state.sessionId,
              incarnation: client.identity.incarnation,
              pid: client.identity.pid,
              status: state.isStreaming ? "busy" : "ready",
            },
          };
        })(),
      ]);
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertSession(
    session: import("./bay.ts").BaySession,
    execution: Extract<RunExecution, { kind: "bay" }>,
    legacy = false,
  ): void {
    try {
      assertBaySession(session, {
        name: execution.sessionName,
        id: execution.recordId,
        generation: execution.generation ?? (legacy ? undefined : 1),
        agent: execution.agent,
      });
    } catch (error) {
      throw new ExecutionChanged(error instanceof Error ? error.message : String(error));
    }
  }

  private credentials({ attempt }: ExecutionContext): Record<string, string> {
    if (attempt.execution.kind !== "bay" || !attempt.execution.agent.manifest.credentials.length) return {};
    const path = this.environment.PITUITARY_CREDENTIAL_PROFILES;
    if (!path) throw new Error("Agent credential profiles are not configured");
    const profiles = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      { provider: string; file: string }
    >;
    const keys: Record<string, string> = Object.create(null);
    for (const name of attempt.execution.agent.manifest.credentials) {
      const profile = profiles[name];
      if (
        !profile ||
        typeof profile.provider !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(profile.provider) ||
        typeof profile.file !== "string" ||
        !profile.file.startsWith("/")
      )
        throw new Error("Missing or invalid credential profile " + name);
      if (Object.hasOwn(keys, profile.provider))
        throw new Error("Multiple credential profiles select provider " + profile.provider);
      const key = readFileSync(profile.file, "utf8").trim();
      if (!key || Buffer.byteLength(key) > 64 * 1024)
        throw new Error("Empty or oversized credential profile " + name);
      keys[profile.provider] = key;
    }
    return keys;
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 500);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
