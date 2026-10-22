import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBaySession, Bay } from "./bay.ts";
import { type AgentCatalog, loadCatalog } from "./catalog.ts";
import { agentManifestDigest } from "./protocol.ts";
import { privateDirectory, type Run, RunStore } from "./store.ts";
import { connectWorker, type WorkerClient } from "./worker-client.ts";

export interface RuntimeOptions {
  stateDirectory: string;
  /** Test/source runners can supply another worker speaking the same protocol. */
  workerCommand?: readonly string[];
  workerEnvironment?: NodeJS.ProcessEnv;
  startupTimeout?: number;
  catalog?: AgentCatalog;
  catalogFile?: string;
  bayCommand?: string;
}

/** Run intent is durable before either a local process or a Bay machine is launched. */
export class Runtime {
  readonly store: RunStore;
  private readonly command: readonly string[];

  constructor(private readonly options: RuntimeOptions) {
    this.command = options.workerCommand ?? [
      process.execPath,
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
    ];
    if (!this.command[0]) throw new Error("Worker command must not be empty");
    this.store = new RunStore(options.stateDirectory);
  }

  async start(input: {
    name?: string;
    cwd: string;
    prompt?: string;
    agent?: string;
    repos?: readonly string[];
  }): Promise<Run> {
    const catalog = input.agent ? (this.options.catalog ?? loadCatalog(this.options.catalogFile)) : undefined;
    const agent = input.agent ? catalog?.agents[input.agent] : undefined;
    if (input.agent && !agent) throw new Error(`No declared agent named ${input.agent}`);
    if (agent?.manifest.credentials.length)
      throw new Error("This agent requests credential profiles; profile delivery is not configured yet");
    if (input.repos?.length && !agent) throw new Error("--repo requires a declared --agent");
    let run = this.store.create({
      ...input,
      bay:
        agent && catalog
          ? {
              socket: catalog.baySocket,
              command: this.options.bayCommand ?? process.env.PITUITARY_BAY_COMMAND ?? "bay",
              agent,
              repos: input.repos ?? [],
            }
          : undefined,
    });
    let child: ChildProcess | undefined;
    let client: WorkerClient | null = null;
    try {
      privateDirectory(run.directory);
      if (run.execution.kind === "bay") {
        const execution = run.execution;
        this.store.update(run.id, {}, "bay_starting");
        const session = await new Bay(execution.socket, execution.command).start(
          execution.sessionName,
          execution.agent,
          execution.repos,
        );
        assertBaySession(session, { name: execution.sessionName, agent: execution.agent });
        run = this.store.update(run.id, { execution: { ...execution, recordId: session.id } }, "bay_started");
      } else {
        const log = openSync(join(run.directory, "worker.log"), "a", 0o600);
        try {
          child = spawn(
            this.command[0] as string,
            [...this.command.slice(1), "--socket", run.socket, "--state", run.directory, "--cwd", run.cwd],
            {
              cwd: run.cwd,
              detached: true,
              stdio: ["ignore", log, log],
              env: { ...process.env, ...this.options.workerEnvironment },
            },
          );
        } finally {
          closeSync(log);
        }
        child.unref();
        this.store.update(run.id, { pid: child.pid ?? null }, "worker_starting");
      }
      let failure: Error | null = null;
      child?.once("error", (error) => {
        failure = error;
      });
      const until = Date.now() + (this.options.startupTimeout ?? 15_000);
      while (Date.now() < until) {
        if (failure) throw failure;
        if (child && (child.exitCode !== null || child.signalCode !== null))
          throw new Error(`Worker exited before becoming ready; see ${join(run.directory, "worker.log")}`);
        try {
          client =
            run.execution.kind === "local"
              ? await connectWorker(run.socket, { timeout: Math.max(1, until - Date.now()) })
              : await new Bay(run.execution.socket, run.execution.command).connect(
                  run.execution.sessionName,
                  run.execution.recordId as string,
                  true,
                  Math.max(1, until - Date.now()),
                );
          break;
        } catch {
          await pause(25);
        }
      }
      if (!client) throw new Error(`Worker did not become ready; see ${join(run.directory, "worker.log")}`);
      const result = await this.activate(run, client, until);
      return result;
    } catch (error) {
      if (child && this.store.get(run.id).sessionId === null) {
        await terminate(child);
        rmSync(run.socket, { force: true });
      }
      const current = this.store.get(run.id);
      this.store.update(
        run.id,
        (latest) =>
          latest.desired === "stopped"
            ? { error: describe(error) }
            : {
                status: current.sessionId || run.execution.kind === "bay" ? "unreachable" : "failed",
                error: describe(error),
                ...(current.promptStatus === "dispatching" ? { promptStatus: "uncertain" as const } : {}),
              },
        "start_failed",
      );
      throw new Error(`Could not start ${run.name}: ${describe(error)}`);
    } finally {
      await client?.close();
    }
  }

  /** Observe without taking the input lease. A lost connection never authorizes a new run. */
  async inspect(name: string): Promise<Run> {
    const run = this.store.get(name);
    if (run.desired === "stopped" || run.status === "stopped" || run.status === "failed") return run;
    let client: WorkerClient | null = null;
    try {
      if (run.execution.kind === "bay" && !run.execution.recordId) {
        const execution = run.execution;
        const session = await new Bay(execution.socket, execution.command).get(execution.sessionName);
        assertBaySession(session, { name: execution.sessionName, agent: execution.agent });
        this.store.update(run.id, { execution: { ...execution, recordId: session.id } }, "bay_reconciled");
      }
      client = await this.connect(this.store.get(run.id), false);
      const state = await client.getState();
      if (run.sessionId && run.sessionId !== state.sessionId)
        throw new Error("Worker conversation changed; explicit recovery is required");
      const status = state.isStreaming ? "busy" : "ready";
      return this.store.update(
        run.id,
        (current) => {
          if (current.desired === "stopped" || current.status === "stopped" || current.status === "failed")
            return null;
          const promptStatus = current.promptStatus === "dispatching" ? "uncertain" : current.promptStatus;
          if (current.status === status && !current.error && promptStatus === current.promptStatus)
            return null;
          return { status, sessionId: state.sessionId, error: null, promptStatus };
        },
        "worker_observed",
      );
    } catch (error) {
      const reason = describe(error);
      return this.store.update(
        run.id,
        (current) => {
          if (current.desired === "stopped" || current.status === "stopped" || current.status === "failed")
            return null;
          if (current.status === "unreachable" && current.error === reason) return null;
          return {
            status: "unreachable",
            error: reason,
            ...(current.promptStatus === "dispatching" ? { promptStatus: "uncertain" as const } : {}),
          };
        },
        "worker_unreachable",
      );
    } finally {
      await client?.close();
    }
  }

  async stop(name: string): Promise<Run> {
    const run = this.store.get(name);
    if (run.status === "stopped") return run;
    this.store.update(run.id, { desired: "stopped", status: "stopping", error: null }, "stop_requested");
    try {
      if (run.execution.kind === "bay") {
        const execution = run.execution;
        const bay = new Bay(execution.socket, execution.command);
        const session = await bay.get(execution.sessionName);
        assertBaySession(session, {
          name: execution.sessionName,
          id: execution.recordId,
          agent: execution.agent,
        });
        if (!execution.recordId)
          this.store.update(run.id, { execution: { ...execution, recordId: session.id } }, "bay_reconciled");
        if (session.state === "running") {
          let client: WorkerClient | null = null;
          try {
            client = await this.connect(this.store.get(run.id), false);
            await client.shutdown();
          } catch (error) {
            this.store.update(run.id, { error: describe(error) }, "worker_shutdown_unavailable");
          } finally {
            await client?.close();
          }
        }
        if (session.state === "running") await bay.suspend(execution.sessionName, session.id);
        return this.store.update(run.id, { status: "stopped", error: null }, "worker_stopped");
      }
      const client = await this.connect(run, false);
      try {
        const state = await client.getState();
        if (run.sessionId && run.sessionId !== state.sessionId)
          throw new Error("Worker conversation changed; refusing to stop another conversation");
        await client.shutdown();
        return this.store.update(run.id, { status: "stopped", error: null }, "worker_stopped");
      } finally {
        await client.close();
      }
    } catch (error) {
      this.store.update(run.id, { error: describe(error) }, "stop_failed");
      throw error;
    }
  }

  close(): void {
    this.store.close();
  }

  /** Reconcile a saved launch; never create another machine or replay an uncertain effect. */
  async recover(name: string): Promise<Run> {
    let run = this.store.get(name);
    if (run.execution.kind !== "bay") throw new Error("Local runs cannot be relaunched by recovery");
    if (run.desired === "stopped" || run.status === "stopped")
      throw new Error("A stopped run cannot be recovered; start a new run");
    const execution = run.execution;
    const bay = new Bay(execution.socket, execution.command);
    let client: WorkerClient | null = null;
    try {
      const session = await bay.get(execution.sessionName);
      assertBaySession(session, {
        name: execution.sessionName,
        id: execution.recordId,
        agent: execution.agent,
      });
      if (session.state !== "running")
        throw new Error(`Bay session is ${session.state}; recovery never relaunches it`);
      run = this.store.update(
        run.id,
        { execution: { ...execution, recordId: session.id } },
        "recovery_requested",
      );
      client = await bay.connect(execution.sessionName, session.id);
      return await this.activate(run, client, Date.now() + (this.options.startupTimeout ?? 15_000));
    } catch (error) {
      this.store.update(
        run.id,
        (current) => ({
          ...(current.desired === "running" ? { status: "unreachable" as const } : {}),
          error: describe(error),
        }),
        "recovery_failed",
      );
      throw error;
    } finally {
      await client?.close();
    }
  }

  private async activate(run: Run, client: WorkerClient, until: number): Promise<Run> {
    if (run.execution.kind === "bay") {
      const initialized = (await client.request(
        { type: "initialize", manifest: run.execution.agent.manifest },
        `run-${run.id}-role`,
        Math.max(1, until - Date.now()),
      )) as { roleDigest: string };
      if (initialized.roleDigest !== agentManifestDigest(run.execution.agent.manifest))
        throw new Error("Worker initialized another role");
    }
    const state = (await client.request(
      { type: "get_state" },
      undefined,
      Math.max(1, until - Date.now()),
    )) as Awaited<ReturnType<WorkerClient["getState"]>>;
    if (run.sessionId && state.sessionId !== run.sessionId)
      throw new Error("Worker conversation changed; explicit recovery is required");
    await client.request(
      { type: "set_session_name", name: run.name },
      `run-${run.id}-name`,
      Math.max(1, until - Date.now()),
    );
    this.store.update(
      run.id,
      (current) => {
        if (current.desired === "stopped") throw new Error("Run was stopped while its worker was starting");
        return { status: state.isStreaming ? "busy" : "ready", sessionId: state.sessionId, error: null };
      },
      "worker_ready",
    );
    if (run.prompt && run.promptStatus !== "accepted") {
      this.store.update(
        run.id,
        (current) => {
          if (current.desired === "stopped") throw new Error("Run was stopped before its initial prompt");
          return { promptStatus: "dispatching" };
        },
        "prompt_dispatching",
      );
      try {
        await client.request({ type: "prompt", message: run.prompt }, `run-${run.id}-initial`);
        this.store.update(run.id, { promptStatus: "accepted" }, "prompt_accepted");
      } catch (error) {
        this.store.update(run.id, { promptStatus: "uncertain", error: describe(error) }, "prompt_uncertain");
        throw error;
      }
    }
    return this.store.get(run.id);
  }

  async connect(target: Run, control: boolean): Promise<WorkerClient> {
    const run = this.store.get(target.id);
    if (control && (run.desired === "stopped" || run.status === "stopped"))
      throw new Error("This run has been stopped; start a new run to send more work");
    if (run.execution.kind === "local") return connectWorker(run.socket, { control });
    const execution = run.execution;
    if (!execution.recordId)
      throw new Error("Bay launch has no confirmed record identity; inspect the run to reconcile it");
    const bay = new Bay(execution.socket, execution.command);
    const session = await bay.get(execution.sessionName);
    assertBaySession(session, {
      name: execution.sessionName,
      id: execution.recordId,
      agent: execution.agent,
    });
    if (session.state !== "running") throw new Error(`Bay session is ${session.state}`);
    const client = await bay.connect(execution.sessionName, execution.recordId, control);
    try {
      const expected = agentManifestDigest(execution.agent.manifest);
      if (!client.identity.roleDigest)
        throw new Error(`Worker awaits its role; run pituitary recover ${run.name}`);
      if (client.identity.roleDigest !== expected) {
        throw new Error("Worker role changed; explicit recovery is required");
      }
      if (run.sessionId && (await client.getState()).sessionId !== run.sessionId)
        throw new Error("Worker conversation changed; explicit recovery is required");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

/** Only a child just created here is eligible for forced startup cleanup. Never signal a saved PID. */
async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 500);
  try {
    await exited;
  } finally {
    clearTimeout(forced);
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
