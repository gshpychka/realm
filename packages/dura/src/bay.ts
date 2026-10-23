import { createHash } from "node:crypto";
import { request } from "node:http";
import { Duplex } from "node:stream";
import type { AgentDefinition } from "./catalog.ts";

export interface BayIdentity {
  sessionName: string;
  recordId: string;
  generation: number;
}
export interface BayBlob {
  sha256: string;
  size: number;
  path: string;
}
export interface BayCommand {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  inputDigest?: string;
  machineRevision: string;
}
export interface BayJob extends BayCommand {
  id: string;
  recordId: string;
  generation: number;
  status: "running" | "succeeded" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export function assertBayJob(job: BayJob, identity: BayIdentity, id: string, command?: BayCommand): void {
  if (
    job.id !== id ||
    job.recordId !== identity.recordId ||
    job.generation !== identity.generation ||
    !["running", "succeeded", "failed", "timed_out"].includes(job.status) ||
    typeof job.stdout !== "string" ||
    typeof job.stderr !== "string" ||
    !Number.isSafeInteger(job.maxOutputBytes) ||
    job.maxOutputBytes < 1 ||
    job.maxOutputBytes > 8 * 1024 * 1024 ||
    // Invalid raw UTF-8 bytes become three-byte replacement runes in Bay's JSON output.
    Buffer.byteLength(job.stdout) + Buffer.byteLength(job.stderr) > 3 * job.maxOutputBytes ||
    !(job.exitCode === null || Number.isSafeInteger(job.exitCode))
  )
    throw new Error("Bay job receipt changed execution identity or exceeded its recorded bounds");
  if (
    command &&
    (JSON.stringify(job.argv) !== JSON.stringify(command.argv) ||
      job.cwd !== command.cwd ||
      job.timeoutMs !== command.timeoutMs ||
      job.maxOutputBytes !== command.maxOutputBytes ||
      (job.inputDigest ?? "") !== (command.inputDigest ?? "") ||
      job.machineRevision !== command.machineRevision)
  )
    throw new Error("Bay job receipt does not match its frozen command, input, or machine");
}

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

export class BayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Bay operator lifecycle, immutable transfer, and execution connections. */
export class Bay {
  constructor(
    readonly socket: string,
    readonly signal?: AbortSignal,
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

  async upload(identity: BayIdentity, bytes: Buffer): Promise<BayBlob> {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const value = JSON.parse(
      (await this.operation(identity, "PUT", "/blobs/" + digest, bytes)).bytes.toString(),
    ) as BayBlob;
    if (value.sha256 !== digest || value.size !== bytes.length || !value.path.startsWith("/"))
      throw new Error("Bay returned a different immutable blob");
    return value;
  }
  async job(identity: BayIdentity, id: string, command?: BayCommand): Promise<BayJob> {
    const job = JSON.parse(
      (
        await this.operation(identity, command ? "POST" : "GET", "/jobs/" + encodeURIComponent(id), command)
      ).bytes.toString(),
    ) as BayJob;
    assertBayJob(job, identity, id, command);
    return job;
  }
  async capture(identity: BayIdentity, id: string, path: string, maxBytes: number): Promise<Buffer> {
    const suffix = "/captures/" + encodeURIComponent(id);
    const value = JSON.parse(
      (await this.operation(identity, "POST", suffix, { path, maxBytes })).bytes.toString(),
    ) as BayBlob;
    if (
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.size) ||
      value.size > maxBytes ||
      value.size < 0
    )
      throw new Error("Bay capture exceeds its declared bounds");
    const result = await this.operation(identity, "GET", suffix, undefined, maxBytes);
    if (
      result.digest !== value.sha256 ||
      result.bytes.length !== value.size ||
      createHash("sha256").update(result.bytes).digest("hex") !== value.sha256
    )
      throw new Error("Bay capture content does not match its immutable receipt");
    return result.bytes;
  }

  private operation(
    identity: BayIdentity,
    method: string,
    suffix: string,
    body?: unknown,
    maxBytes = 64 * 1024 * 1024,
  ): Promise<{ bytes: Buffer; digest?: string }> {
    return new Promise((resolve, reject) => {
      const data = Buffer.isBuffer(body)
        ? body
        : body === undefined
          ? undefined
          : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.socket,
          agent: false,
          signal: this.signal,
          method,
          path: `/v1/sessions/${encodeURIComponent(identity.sessionName)}${suffix}`,
          headers: {
            "Bay-Session-ID": identity.recordId,
            "Bay-Session-Generation": String(identity.generation),
            ...(data
              ? {
                  "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json",
                  "Content-Length": String(data.length),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) response.destroy(new Error("Bay operation exceeds its byte limit"));
            else chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            const bytes = Buffer.concat(chunks),
              status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              let error: { error?: string; code?: string } = {};
              try {
                error = JSON.parse(bytes.toString());
              } catch {}
              reject(new BayError(status, error.error ?? `Bay returned ${status}`, error.code));
              return;
            }
            if (
              response.headers["bay-session-id"] !== identity.recordId ||
              response.headers["bay-session-generation"] !== String(identity.generation)
            ) {
              reject(new Error("Bay operation crossed an execution generation"));
              return;
            }
            resolve({
              bytes,
              digest:
                typeof response.headers["bay-content-sha256"] === "string"
                  ? response.headers["bay-content-sha256"]
                  : undefined,
            });
          });
        },
      );
      req.setTimeout(180_000, () =>
        req.destroy(new Error("Bay operation timed out; its saved job may still be running")),
      );
      req.once("error", reject);
      req.end(data);
    });
  }

  async suspend(name: string, id: string, generation: number): Promise<void> {
    const exact = (session: BaySession): void => {
      if (
        !id ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        session.name !== name ||
        session.id !== id ||
        session.generation !== generation
      )
        throw new Error("Bay execution identity changed before suspension");
    };
    const current = await this.get(name);
    exact(current);
    if (current.state === "suspended") return;
    if (current.state !== "running") throw new Error("Bay execution is unavailable for suspension");
    try {
      await this.call("POST", name, "/suspend", { id, generation });
    } catch (error) {
      if (this.signal?.aborted) throw error;
      if (error instanceof BayError && error.status < 500 && error.status !== 409) throw error;
      // Cleanup can finish concurrently or commit before its response is lost.
      // Only this exact, now-suspended execution satisfies the desired state.
      const observed = await this.get(name);
      exact(observed);
      if (observed.state !== "suspended") throw error;
    }
  }

  environment(identity: BayIdentity, machineRevision: string, signal?: AbortSignal): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          agent: false,
          signal: this.signal && signal ? AbortSignal.any([this.signal, signal]) : (signal ?? this.signal),
          method: "POST",
          path: `/v1/sessions/${encodeURIComponent(identity.sessionName)}/environment`,
          headers: {
            "Content-Type": "application/octet-stream",
            "Bay-Session-ID": identity.recordId,
            "Bay-Session-Generation": String(identity.generation),
            "Bay-Machine-Revision": machineRevision,
          },
        },
        (response) => {
          req.setTimeout(0);
          if (response.statusCode !== 200) {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65536) {
                response.destroy(new Error("Bay environment failure exceeds its byte limit"));
                return;
              }
              chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => {
              let error: { error?: string; code?: string } = {};
              try {
                error = JSON.parse(Buffer.concat(chunks).toString());
              } catch {}
              req.destroy();
              reject(
                new BayError(
                  response.statusCode ?? 500,
                  error.error ?? "Bay environment connection failed",
                  error.code,
                ),
              );
            });
            return;
          }
          if (
            response.headers["bay-session-id"] !== identity.recordId ||
            response.headers["bay-session-generation"] !== String(identity.generation) ||
            response.headers["bay-machine-revision"] !== machineRevision
          ) {
            req.destroy();
            response.destroy();
            reject(new Error("Bay environment returned a different execution identity"));
            return;
          }
          const stream = Duplex.from({ readable: response, writable: req });
          response.once("end", () => {
            if (response.trailers["bay-connection-error"])
              stream.destroy(new Error("Bay environment cleanup or bridge failed"));
          });
          stream.once("close", () => {
            req.destroy();
            response.destroy();
          });
          resolve(stream);
        },
      );
      req.once("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error("Bay environment handshake timed out")));
      req.flushHeaders();
    });
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
          agent: false,
          signal: this.signal,
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
    (expected.id !== undefined && expected.id !== null && session.id !== expected.id) ||
    (expected.generation !== undefined &&
      expected.generation !== null &&
      session.generation !== expected.generation) ||
    session.program !== expected.agent.program ||
    session.machine !== expected.agent.machine ||
    session.machineRevision !== expected.agent.machineRevision
  )
    throw new Error("Bay session identity or machine changed; explicit recovery is required");
}
