import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { type ConversationClient, connectConversation } from "./conversation.ts";
import type { Integration, Question, ReviseTaskInput, Run, RunDetail, StartRunInput, Task } from "./model.ts";
import { socketDirectory } from "./paths.ts";

export {
  ConversationClient,
  type ConversationIdentity,
  connectConversation,
} from "./conversation.ts";

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
  startupTimeout?: number;
  socketPath?: string;
}
export function runtimeSocket(root: string): string {
  return join(socketDirectory(root), "runtime.sock");
}

/** The CLI and UI are disposable clients of one host Pi Durable harness. */
export class Runtime {
  private readonly root: string;
  private readonly socket: string;
  private readiness?: Promise<void>;
  constructor(private readonly options: RuntimeOptions) {
    this.root = resolve(options.stateDirectory);
    const explicit = options.socketPath ?? process.env.DURA_RUNTIME_SOCKET;
    if (explicit !== undefined && !explicit?.startsWith("/"))
      throw new Error("Runtime socket must be an absolute path");
    this.socket = explicit ?? runtimeSocket(this.root);
  }
  async start(input: StartRunInput, id: string = randomUUID(), catalogFile?: string): Promise<Run> {
    await this.ensure();
    return this.call(
      "POST",
      "/v1/runs",
      { id, ...input, ...(catalogFile ? { catalogFile } : {}) },
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
    return this.call("POST", `/v1/runs/${encodeURIComponent(name)}/stop`, { id }, 240_000);
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
  /** Wait for an existing host. Connecting never starts or configures a server. */
  ready(): Promise<void> {
    return this.ensure();
  }
  private ensure(): Promise<void> {
    this.readiness ??= this.waitUntilReady().catch((error) => {
      this.readiness = undefined;
      throw error;
    });
    return this.readiness;
  }
  private async waitUntilReady(
    deadline = Date.now() + (this.options.startupTimeout ?? 15_000),
  ): Promise<void> {
    while (Date.now() < deadline) {
      try {
        await this.call("GET", "/v1/status", undefined, 1000);
        return;
      } catch (error) {
        if (!(error instanceof RuntimeError) || error.status !== 503) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error(`Runtime did not become ready; see ${join(this.root, "runtime.log")}`);
  }
  private async call<T>(method: string, path: string, body?: unknown, timeout = 15_000): Promise<T> {
    try {
      return await this.request<T>(method, path, body, timeout);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (path === "/v1/status" || !["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(code ?? ""))
        throw error;
      this.readiness = undefined;
      // A refused connection dispatched nothing. Never replay an uncertain command.
      if (code === "ECONNRESET") throw error;
      await this.ensure();
      return this.request<T>(method, path, body, timeout);
    }
  }
  private request<T>(method: string, path: string, body?: unknown, timeout = 15_000): Promise<T> {
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
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
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
