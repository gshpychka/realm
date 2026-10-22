import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCatalog } from "./catalog.ts";
import { privateDirectory, type Run, type RunDetail, socketDirectory } from "./store.ts";
import { connectWorker, type WorkerClient } from "./worker-client.ts";

export type { RunDetail } from "./store.ts";
export interface RuntimeOptions {
  stateDirectory: string;
  catalogFile?: string;
  catalog?: AgentCatalog;
  workerCommand?: readonly string[];
  workerEnvironment?: NodeJS.ProcessEnv;
  startupTimeout?: number;
  bayCommand?: string;
  autoStart?: boolean;
}
export function runtimeSocket(root: string): string {
  return join(socketDirectory(root), "runtime.sock");
}

/** The CLI and UI are clients. One host runtime owns the database and workers. */
export class Runtime {
  private readonly root: string;
  private readonly socket: string;
  private ready?: Promise<void>;
  constructor(private readonly options: RuntimeOptions) {
    if (options.workerCommand && !options.workerCommand.length)
      throw new Error("Worker command must not be empty");
    this.root = resolve(options.stateDirectory);
    this.socket = runtimeSocket(this.root);
  }
  async start(input: {
    name?: string;
    cwd: string;
    prompt?: string;
    agent?: string;
    repos?: readonly string[];
  }): Promise<Run> {
    await this.ensure();
    return this.call(
      "POST",
      "/v1/runs",
      {
        id: randomUUID(),
        ...input,
        ...(this.options.catalogFile ? { catalogFile: this.options.catalogFile } : {}),
      },
      240_000,
    );
  }
  async list(): Promise<Run[]> {
    await this.ensure();
    return this.call("GET", "/v1/runs");
  }
  async inspect(name: string): Promise<RunDetail> {
    await this.ensure();
    return this.call("GET", "/v1/runs/" + encodeURIComponent(name));
  }
  async stop(name: string): Promise<Run> {
    await this.ensure();
    return this.call("POST", "/v1/runs/" + encodeURIComponent(name) + "/stop", { id: randomUUID() });
  }
  async recover(name: string): Promise<Run> {
    await this.ensure();
    return this.call("POST", "/v1/runs/" + encodeURIComponent(name) + "/recover", { id: randomUUID() });
  }
  async connect(run: Run | string, control: boolean, taskId?: string): Promise<WorkerClient> {
    await this.ensure();
    const target = await this.call<{ socket: string }>(
      "POST",
      "/v1/runs/" + encodeURIComponent(typeof run === "string" ? run : run.id) + "/attach",
      { taskId },
      240_000,
    );
    return connectWorker(target.socket, { control });
  }
  async attach(name: string, taskId?: string): Promise<WorkerClient> {
    return this.connect(name, true, taskId);
  }
  /** Disposing a client leaves the runtime and its work alive. */
  close(): void {}
  private ensure(): Promise<void> {
    this.ready ??= this.connectOrStart();
    return this.ready;
  }
  private async connectOrStart(): Promise<void> {
    try {
      await this.call("GET", "/v1/status", undefined, 1000);
      return;
    } catch (error) {
      if (this.options.autoStart === false) throw error;
      if (
        !(error instanceof Error) ||
        !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
    }
    privateDirectory(this.root);
    const log = openSync(join(this.root, "runtime.log"), "a", 0o600);
    let failure: Error | undefined;
    try {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./supervisor.ts", import.meta.url)), "--state", this.root],
        {
          detached: true,
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            ...this.options.workerEnvironment,
            ...(this.options.catalogFile ? { PITUITARY_CATALOG: this.options.catalogFile } : {}),
            ...(this.options.catalog
              ? { PITUITARY_SOURCE_CATALOG: JSON.stringify(this.options.catalog) }
              : {}),
            ...(this.options.workerCommand
              ? { PITUITARY_WORKER_COMMAND: JSON.stringify(this.options.workerCommand) }
              : {}),
            ...(this.options.bayCommand ? { PITUITARY_BAY_COMMAND: this.options.bayCommand } : {}),
            ...(this.options.startupTimeout
              ? { PITUITARY_STARTUP_TIMEOUT: String(this.options.startupTimeout) }
              : {}),
          },
        },
      );
      child.on("error", (error) => {
        failure = error;
      });
      child.unref();
    } finally {
      closeSync(log);
    }
    const deadline = Date.now() + (this.options.startupTimeout ?? 15_000);
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try {
        await this.call("GET", "/v1/status", undefined, 1000);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("Runtime did not become ready; see " + join(this.root, "runtime.log"));
  }
  private call<T>(method: string, path: string, body?: unknown, timeout = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          method,
          path,
          agent: false,
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 8 * 1024 * 1024)
              response.destroy(new Error("Runtime response exceeds its byte limit"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString());
              if ((response.statusCode ?? 500) >= 300)
                reject(new Error(value.error ?? "Runtime request failed"));
              else resolve(value as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(timeout, () =>
        req.destroy(new Error("Runtime response timed out; the saved command may still complete")),
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}
