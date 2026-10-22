import { spawn } from "node:child_process";
import { request } from "node:http";
import { Duplex } from "node:stream";
import type { AgentDefinition } from "./catalog.ts";
import { WorkerClient } from "./worker-client.ts";

export interface BaySession {
  id: string;
  generation: number;
  name: string;
  state: "running" | "suspended" | "ended";
  program: string;
  machine: string;
  machineRevision: string;
  snapshots?: string[];
  repos?: Array<{ owner: string; name: string; commit: string; branch?: string }>;
}

export interface BayMessage {
  id: number;
  thread: number;
  from: string;
  fromId: string;
  fromGeneration: number;
  to: string;
  toId: string;
  body: string;
  sent: string;
}
export interface MailPage {
  messages: BayMessage[];
  next: string;
  more: boolean;
}

export class BayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The operator uses Bay's JSON API for lifecycle and its raw stream for worker traffic. */
export class Bay {
  constructor(
    readonly socket: string,
    readonly command = process.env.PITUITARY_BAY_COMMAND ?? "bay",
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  start(name: string, agent: AgentDefinition, repos: readonly string[]): Promise<BaySession> {
    return this.call("POST", name, "/start", {
      program: agent.program,
      machineRevision: agent.machineRevision,
      repos,
    });
  }

  get(name: string): Promise<BaySession> {
    return this.call("GET", name);
  }

  async suspend(name: string, id: string, generation: number): Promise<void> {
    await this.call("POST", name, "/suspend", { id, generation });
  }

  async send(
    name: string,
    input: {
      id: string;
      generation: number;
      to: string;
      toId?: string;
      clientId: string;
      body: string;
      thread?: number;
    },
  ): Promise<unknown> {
    return this.call("POST", name, "/messages", input);
  }

  async feed(after?: string): Promise<MailPage> {
    return this.json(
      "GET",
      "/v1/messages/feed" + (after ? "?after=" + encodeURIComponent(after) : ""),
      undefined,
      5000,
      2 * 1024 * 1024,
    );
  }

  async connect(
    name: string,
    id: string,
    options: { control?: boolean; timeout?: number; generation?: number; supervisor?: boolean } = {},
  ): Promise<WorkerClient> {
    const argv = ["connect", name, "--id", id];
    if (options.generation !== undefined) argv.push("--generation", String(options.generation));
    const child = spawn(this.command, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...this.environment, BAY_SOCKET: this.socket },
    });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-8192);
    });
    child.once("error", (cause) => stream.destroy(cause));
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal)
        stream.destroy(new Error(`Bay connection exited: ${error.trim() || signal || code}`));
    });
    stream.once("close", () => {
      child.kill("SIGTERM");
    });
    return new WorkerClient(stream, options.control !== false, options.timeout ?? 10_000, {
      supervisor: options.supervisor,
    }).connected();
  }

  private call<T>(method: string, name: string, suffix = "", body?: unknown): Promise<T> {
    return this.json(method, `/v1/sessions/${encodeURIComponent(name)}${suffix}`, body);
  }

  private json<T>(
    method: string,
    path: string,
    body?: unknown,
    timeout = 180_000,
    maxBytes = 1024 * 1024,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          path,
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              response.destroy(new Error("Bay response exceeds its byte limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const status = response.statusCode ?? 500;
              if (status < 200 || status >= 300)
                reject(
                  new BayError(
                    status,
                    data.error ?? `Bay returned ${status}`,
                    typeof data.code === "string" ? data.code : undefined,
                  ),
                );
              else resolve(data as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(timeout, () =>
        req.destroy(new Error("Bay request timed out; its outcome may be pending")),
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}

export function assertBaySession(
  session: BaySession,
  expected: { name: string; id?: string | null; generation?: number | null; agent: AgentDefinition },
): void {
  if (
    !session.id ||
    session.name !== expected.name ||
    (expected.id && session.id !== expected.id) ||
    (expected.generation !== undefined &&
      expected.generation !== null &&
      session.generation !== expected.generation) ||
    session.program !== expected.agent.program ||
    session.machine !== expected.agent.machine ||
    session.machineRevision !== expected.agent.machineRevision
  )
    throw new Error("Bay session identity or machine changed; explicit recovery is required");
}
