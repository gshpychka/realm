import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCatalog } from "./catalog.ts";
import { type ConversationClient, connectConversation } from "./conversation.ts";
import type { Integration, Question, ReviseTaskInput, Run, RunDetail, StartRunInput, Task } from "./model.ts";
import { privateDirectory, socketDirectory } from "./paths.ts";

export type {
  Artifact,
  Integration,
  Question,
  Report,
  ReviseTaskInput,
  RunDetail,
  Task,
  TaskDetail,
  Verification,
} from "./model.ts";
export interface RuntimeOptions {
  stateDirectory: string;
  catalogFile?: string;
  catalog?: AgentCatalog;
  environment?: NodeJS.ProcessEnv;
  startupTimeout?: number;
  autoStart?: boolean;
  socketPath?: string;
}
export function runtimeSocket(root: string): string {
  return join(socketDirectory(root), "runtime.sock");
}

/** The CLI and UI are disposable clients of one host Pi Durable harness. */
export class Runtime {
  private readonly root: string;
  private readonly socket: string;
  private ready?: Promise<void>;
  private readonly external: boolean;
  constructor(private readonly options: RuntimeOptions) {
    this.root = resolve(options.stateDirectory);
    const explicit = options.socketPath ?? process.env.PITUITARY_RUNTIME_SOCKET;
    if (explicit !== undefined && !explicit?.startsWith("/"))
      throw new Error("Runtime socket must be an absolute path");
    this.external = explicit !== undefined;
    this.socket = explicit ?? runtimeSocket(this.root);
  }
  async start(input: StartRunInput, id: string = randomUUID()): Promise<Run> {
    await this.ensure();
    return this.call(
      "POST",
      "/v1/runs",
      {
        id,
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
    return this.call("GET", `/v1/runs/${encodeURIComponent(name)}`);
  }
  async stop(name: string, id: string = randomUUID()): Promise<Run> {
    await this.ensure();
    return this.call("POST", `/v1/runs/${encodeURIComponent(name)}/stop`, { id });
  }
  async recover(name: string, id: string = randomUUID()): Promise<Run> {
    await this.ensure();
    return this.call("POST", `/v1/runs/${encodeURIComponent(name)}/recover`, { id });
  }
  async answer(questionId: string, answer: string, id: string = randomUUID()): Promise<Question> {
    await this.ensure();
    return this.call("POST", `/v1/questions/${encodeURIComponent(questionId)}/answer`, { id, answer });
  }
  async retry(taskId: string, revision: number, id: string = randomUUID()): Promise<Task> {
    await this.ensure();
    return this.call("POST", `/v1/tasks/${encodeURIComponent(taskId)}/retry`, { id, revision });
  }
  async revise(
    taskId: string,
    revision: number,
    input: ReviseTaskInput,
    id: string = randomUUID(),
  ): Promise<Task> {
    await this.ensure();
    return this.call("POST", `/v1/tasks/${encodeURIComponent(taskId)}/revise`, { id, revision, input });
  }
  async integrate(taskId: string, revision: number, id: string = randomUUID()): Promise<Integration> {
    await this.ensure();
    return this.call("POST", `/v1/tasks/${encodeURIComponent(taskId)}/integrate`, { id, revision });
  }
  async apply(name: string, id: string = randomUUID()): Promise<{ artifactId: string; applied: boolean }> {
    await this.ensure();
    return this.call("POST", `/v1/runs/${encodeURIComponent(name)}/apply`, { id }, 240_000);
  }
  async connect(
    run: Run | string,
    control: boolean,
    taskId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationClient> {
    await this.ensure();
    const current = typeof run === "string" ? (await this.inspect(run)).run : run;
    return connectConversation({
      socketPath: this.socket,
      runId: current.id,
      taskId: taskId ?? current.rootTaskId,
      control,
      signal,
      timeout: 240_000,
    });
  }
  async attach(name: string, taskId?: string): Promise<ConversationClient> {
    return this.connect(name, true, taskId);
  }
  /** Disposing a client leaves the runtime and its work alive. */
  close(): void {}
  private ensure(): Promise<void> {
    this.ready ??= this.connectOrStart().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
  private async connectOrStart(): Promise<void> {
    let opening = false;
    let failure: Error | undefined;
    try {
      await this.call("GET", "/v1/status", undefined, 1000);
      return;
    } catch (error) {
      opening = error instanceof RuntimeError && error.status === 503;
      if (!opening && (this.options.autoStart === false || this.external)) throw error;
      if (
        !opening &&
        (!(error instanceof Error) ||
          !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
      )
        throw error;
    }
    if (!opening) {
      privateDirectory(this.root);
      const log = openSync(join(this.root, "runtime.log"), "a", 0o600);
      try {
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL("./supervisor.ts", import.meta.url)), "--state", this.root],
          {
            detached: true,
            stdio: ["ignore", log, log],
            env: {
              ...process.env,
              ...this.options.environment,
              ...(this.options.catalogFile ? { PITUITARY_CATALOG: this.options.catalogFile } : {}),
              ...(this.options.catalog
                ? { PITUITARY_SOURCE_CATALOG: JSON.stringify(this.options.catalog) }
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
    throw new Error(`Runtime did not become ready; see ${join(this.root, "runtime.log")}`);
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
            if (bytes > 64 * 1024 * 1024)
              response.destroy(new Error("Runtime response exceeds its byte limit"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString());
              if ((response.statusCode ?? 500) >= 300)
                reject(new RuntimeError(response.statusCode ?? 500, value.error ?? "Runtime request failed"));
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

class RuntimeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
