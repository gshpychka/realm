import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, type Run, RunStore } from "./store.ts";
import { connectWorker, type WorkerClient } from "./worker-client.ts";

export interface RuntimeOptions {
  stateDirectory: string;
  /** Test/source runners can supply another worker speaking the same protocol. */
  workerCommand?: readonly string[];
  workerEnvironment?: NodeJS.ProcessEnv;
  startupTimeout?: number;
}

/** The first runtime slice: durable local runs with reconnectable, independent workers. */
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

  async start(input: { name?: string; cwd: string; prompt?: string }): Promise<Run> {
    const run = this.store.create(input);
    let child: ChildProcess | undefined;
    let client: WorkerClient | null = null;
    let ready = false;
    try {
      privateDirectory(run.directory);
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
      let failure: Error | null = null;
      child.once("error", (error) => {
        failure = error;
      });
      this.store.update(run.id, { pid: child.pid ?? null }, "worker_starting");
      const until = Date.now() + (this.options.startupTimeout ?? 15_000);
      while (Date.now() < until) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Worker exited before becoming ready; see ${join(run.directory, "worker.log")}`);
        try {
          client = await connectWorker(run.socket, { timeout: Math.max(1, until - Date.now()) });
          break;
        } catch {
          await pause(25);
        }
      }
      if (!client) throw new Error(`Worker did not become ready; see ${join(run.directory, "worker.log")}`);
      const state = (await client.request(
        { type: "get_state" },
        undefined,
        Math.max(1, until - Date.now()),
      )) as Awaited<ReturnType<WorkerClient["getState"]>>;
      await client.request(
        { type: "set_session_name", name: run.name },
        `run-${run.id}-name`,
        Math.max(1, until - Date.now()),
      );
      ready = true;
      this.store.update(
        run.id,
        { status: state.isStreaming ? "busy" : "ready", sessionId: state.sessionId, error: null },
        "worker_ready",
      );
      if (run.prompt) {
        this.store.update(run.id, { promptStatus: "dispatching" }, "prompt_dispatching");
        try {
          await client.request({ type: "prompt", message: run.prompt }, `run-${run.id}-initial`);
          this.store.update(run.id, { promptStatus: "accepted" }, "prompt_accepted");
        } catch (error) {
          this.store.update(
            run.id,
            { promptStatus: "uncertain", error: describe(error) },
            "prompt_uncertain",
          );
          throw error;
        }
      }
      return this.store.get(run.id);
    } catch (error) {
      if (!ready && child) {
        await terminate(child);
        rmSync(run.socket, { force: true });
      }
      const current = this.store.get(run.id);
      this.store.update(
        run.id,
        {
          status: ready ? "unreachable" : "failed",
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
    if (run.status === "stopped" || run.status === "failed") return run;
    let client: WorkerClient | null = null;
    try {
      client = await connectWorker(run.socket, { control: false });
      const state = await client.getState();
      if (run.sessionId && run.sessionId !== state.sessionId)
        throw new Error("Worker conversation changed; explicit recovery is required");
      const status = state.isStreaming ? "busy" : "ready";
      return this.store.update(
        run.id,
        (current) => {
          if (current.status === "stopped" || current.status === "failed") return null;
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
          if (current.status === "stopped" || current.status === "failed") return null;
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
    const client = await connectWorker(run.socket, { control: false });
    try {
      const state = await client.getState();
      if (run.sessionId && run.sessionId !== state.sessionId)
        throw new Error("Worker conversation changed; refusing to stop another conversation");
      this.store.update(run.id, { error: null }, "stop_requested");
      await client.shutdown();
      return this.store.update(run.id, { status: "stopped", error: null }, "worker_stopped");
    } finally {
      await client.close();
    }
  }

  close(): void {
    this.store.close();
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
