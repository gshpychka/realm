import { spawn } from "node:child_process";
import { request } from "node:http";
import { Duplex } from "node:stream";
import type { AgentDefinition } from "./catalog.ts";
import { WorkerClient } from "./worker-client.ts";

export interface BaySession {
  id: string;
  name: string;
  state: "running" | "suspended" | "ended";
  program: string;
  machine: string;
  machineRevision: string;
  snapshots?: string[];
}

export class BayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The operator uses Bay's JSON API for lifecycle and its raw stream for worker traffic. */
export class Bay {
  constructor(
    readonly socket: string,
    readonly command = process.env.PITUITARY_BAY_COMMAND ?? "bay",
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

  async suspend(name: string, id: string): Promise<void> {
    await this.call("POST", name, "/suspend", { id });
  }

  async connect(name: string, id: string, control = true, timeout = 10_000): Promise<WorkerClient> {
    const child = spawn(this.command, ["connect", name, "--id", id], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BAY_SOCKET: this.socket },
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
    return new WorkerClient(stream, control, timeout).connected();
  }

  private call<T>(method: string, name: string, suffix = "", body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          path: `/v1/sessions/${encodeURIComponent(name)}${suffix}`,
          method,
          headers: body === undefined ? {} : { "Content-Type": "application/json" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
              response.destroy(new Error("Bay response exceeds 1 MiB"));
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
                reject(new BayError(status, data.error ?? `Bay returned ${status}`));
              else resolve(data as T);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(180_000, () =>
        req.destroy(new Error("Bay request timed out; its outcome may be pending")),
      );
      req.once("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}

export function assertBaySession(
  session: BaySession,
  expected: { name: string; id?: string | null; agent: AgentDefinition },
): void {
  if (
    !session.id ||
    session.name !== expected.name ||
    (expected.id && session.id !== expected.id) ||
    session.program !== expected.agent.program ||
    session.machine !== expected.agent.machine ||
    session.machineRevision !== expected.agent.machineRevision
  )
    throw new Error("Bay session identity or machine changed; explicit recovery is required");
}
