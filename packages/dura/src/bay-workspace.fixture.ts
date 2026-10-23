import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, posix, resolve } from "node:path";
import type { BayCommand, BayJob, BaySession } from "./bay.ts";
import type { AgentCatalog, AgentDefinition } from "./catalog.ts";

interface EnvironmentRequest {
  id: number;
  op: string;
  path: string;
  to: string;
  handle: number;
  offset: number;
  length: number;
  data: string;
  command: string | readonly string[];
  timeoutMs?: number;
  append?: boolean;
  recursive?: boolean;
  force?: boolean;
  prefix?: string;
  suffix?: string;
}

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
interface Guest {
  session: BaySession;
  work: string;
  temporary: string;
  jobs: Map<string, BayJob>;
  captures: Map<string, Buffer>;
}
const info = (path: string, st: Awaited<ReturnType<typeof lstat>>) => ({
  name: posix.basename(path),
  path,
  kind: st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file",
  size: st.size,
  mtimeMs: st.mtimeMs,
});

/** Test only: real files/Git/child processes behind Bay's actual Unix HTTP wire.
 * Real guest privilege and cgroup behavior live in the nested VM test. */
export async function bayWorkspaceFixture(
  root: string,
  agents: Record<string, AgentDefinition>,
  options: {
    beforeJob?: (session: BaySession, command: BayCommand) => Promise<void>;
    beforeStart?: (session: BaySession) => Promise<void>;
  } = {},
) {
  const socket = join(root, "bay.sock"),
    guests = new Map<string, Guest>(),
    dispatches = new Map<string, number>(),
    environmentOperations: string[] = [];
  const running = new Set<ChildProcess>();
  const links = new Set<() => Promise<void>>();
  const catalog: AgentCatalog = { schemaVersion: 1, baySocket: socket, agents };
  const respond = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  const local = (guest: Guest, path: string) => {
    if (path === "/work" || path.startsWith("/work/")) return resolve(guest.work, "." + path.slice(5));
    if (path === "/tmp" || path.startsWith("/tmp/")) return resolve(guest.temporary, "." + path.slice(4));
    throw Object.assign(new Error("Guest path outside its test namespace: " + path), { code: "EACCES" });
  };
  const stop = (child: ChildProcess) => {
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
  };
  const execute = (
    guest: Guest,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    maxBytes: number,
    onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
  ) =>
    new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>((done, reject) => {
      const rewrite = (part: string) => part.replaceAll("/work/", guest.work + "/");
      const [command, ...args] = argv.map(rewrite);
      if (!command) {
        reject(new Error("No executable"));
        return;
      }
      const child = spawn(command, args, {
        cwd,
        detached: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.add(child);
      let stdout = "",
        stderr = "",
        bytes = 0,
        timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            stop(child);
          }, timeoutMs)
        : undefined;
      for (const stream of ["stdout", "stderr"] as const)
        child[stream]!.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            stop(child);
            return;
          }
          if (stream === "stdout") stdout += chunk.toString();
          else stderr += chunk.toString();
          onOutput?.(stream, chunk);
        });
      child.once("error", (error) => {
        if (timer) clearTimeout(timer);
        running.delete(child);
        reject(error);
      });
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        running.delete(child);
        done({ stdout, stderr, exitCode: code ?? -1, timedOut });
      });
    });
  async function environment(request: IncomingMessage, response: ServerResponse, guest: Guest) {
    const handles = new Map<number, { file: FileHandle; path: string }>(),
      commands = new Map<number, () => void>();
    let nextHandle = 0,
      pending = "",
      queue = Promise.resolve(),
      closing = false;
    const send = (frame: unknown) => {
      if (!response.destroyed) response.write(JSON.stringify(frame) + "\n");
    };
    const close = async () => {
      if (closing) return;
      closing = true;
      for (const cancel of commands.values()) cancel();
      await Promise.allSettled([...handles.values()].map((handle) => handle.file.close()));
      response.end();
      links.delete(close);
    };
    links.add(close);
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.flushHeaders();
    const shell = async (r: EnvironmentRequest) => {
      // This fixture maps guest paths; actual namespace isolation is tested in the VM.
      const rewrite = (part: string) =>
        part.replace(/\/(work|tmp)(?=\/|$|[\s'";])/g, (_, directory) =>
          directory === "work" ? guest.work : guest.temporary,
        );
      const argv = (typeof r.command === "string" ? ["sh", "-c", r.command] : r.command).map(rewrite);
      if (!argv[0]) throw new Error("No fixture executable");
      const child = spawn(argv[0], argv.slice(1), {
        cwd: local(guest, r.path),
        detached: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      running.add(child);
      let cancelled: "aborted" | "timeout" | undefined;
      commands.set(r.id, () => {
        cancelled = "aborted";
        stop(child);
      });
      const timer = r.timeoutMs
        ? setTimeout(() => {
            cancelled = "timeout";
            stop(child);
          }, r.timeoutMs)
        : undefined;
      for (const stream of ["stdout", "stderr"] as const)
        child[stream]!.on("data", (chunk: Buffer) =>
          send({ id: r.id, stream, data: chunk.toString("base64") }),
        );
      child.once("error", (error) =>
        send({ id: r.id, error: { code: "spawn_error", message: error.message } }),
      );
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        commands.delete(r.id);
        running.delete(child);
        send({
          id: r.id,
          value: { exitCode: code ?? -1 },
          ...(cancelled ? { error: { code: cancelled, message: "command " + cancelled } } : {}),
        });
      });
    };
    const handle = async (r: EnvironmentRequest) => {
      environmentOperations.push(r.op);
      let value: unknown;
      try {
        switch (r.op) {
          case "exec":
            void shell(r);
            return;
          case "cancel": {
            commands.get(r.handle)?.();
            return;
          }
          case "open":
          case "openWrite": {
            const file = await open(local(guest, r.path), r.op === "open" ? "r" : r.append ? "a" : "w");
            handles.set(++nextHandle, { file, path: r.path });
            value = nextHandle;
            break;
          }
          case "read": {
            const h = handles.get(r.handle)!;
            const bytes = Buffer.alloc(r.length),
              result = await h.file.read(bytes, 0, bytes.length, r.offset);
            value = bytes.subarray(0, result.bytesRead).toString("base64");
            break;
          }
          case "writeChunk":
            await handles.get(r.handle)!.file.write(Buffer.from(r.data, "base64"));
            break;
          case "close": {
            const h = handles.get(r.handle);
            handles.delete(r.handle);
            await h?.file.close();
            break;
          }
          case "handleInfo": {
            const h = handles.get(r.handle)!;
            value = info(h.path, await h.file.stat());
            break;
          }
          case "canonical": {
            const path = await realpath(local(guest, r.path));
            value = path.startsWith(guest.work)
              ? "/work" + path.slice(guest.work.length)
              : "/tmp" + path.slice(guest.temporary.length);
            break;
          }
          case "info":
            value = info(r.path, await lstat(local(guest, r.path)));
            break;
          case "exists":
            try {
              await stat(local(guest, r.path));
              value = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              value = false;
            }
            break;
          case "mkdir":
            await mkdir(local(guest, r.path), { recursive: r.recursive });
            break;
          case "rename":
            await rename(local(guest, r.path), local(guest, r.to));
            break;
          case "remove":
            await rm(local(guest, r.path), { recursive: r.recursive, force: r.force });
            break;
          case "flush": {
            const file = await open(local(guest, r.path), "r+");
            try {
              await file.sync();
            } finally {
              await file.close();
            }
            break;
          }
          case "tempDir": {
            const path = await mkdtemp(join(guest.temporary, r.prefix ?? "temp-"));
            value = "/tmp/" + path.slice(guest.temporary.length + 1);
            break;
          }
          case "tempFile": {
            const path = join(guest.temporary, (r.prefix ?? "") + randomUUID() + (r.suffix ?? ""));
            const file = await open(path, "wx");
            await file.close();
            value = "/tmp/" + path.slice(guest.temporary.length + 1);
            break;
          }
          default:
            throw new Error("Unsupported fixture operation " + r.op);
        }
        send({ id: r.id, value });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        send({
          id: r.id,
          error: {
            code: code === "ENOENT" ? "not_found" : code === "EACCES" ? "permission_denied" : "unknown",
            message: String(error),
          },
        });
      }
    };
    request.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const r = JSON.parse(pending.slice(0, end)) as EnvironmentRequest;
        pending = pending.slice(end + 1);
        queue = queue.then(() => handle(r));
      }
    });
    request.once("end", () => {
      void queue.then(close);
    });
    request.once("aborted", () => {
      void close();
    });
    response.once("close", () => {
      void close();
    });
  }
  const server = createServer((request, response) => {
    void (async () => {
      const match = /^\/v1\/sessions\/([^/]+)(.*)$/.exec(request.url ?? "");
      if (!match) {
        respond(response, 404, { error: "No route" });
        return;
      }
      const name = decodeURIComponent(match[1]!),
        suffix = match[2]!,
        method = request.method;
      let guest = guests.get(name);
      if (suffix === "/start" && method === "POST") {
        const spec = JSON.parse((await body(request)).toString());
        if (guest) {
          respond(response, 409, { error: "Session exists" });
          return;
        }
        const agent = Object.values(agents).find((agent) => agent.program === spec.program);
        if (!agent || agent.machineRevision !== spec.machineRevision) {
          respond(response, 409, { error: "Declaration changed", code: "launch_rejected" });
          return;
        }
        const directory = join(root, "guest-" + randomUUID()),
          work = join(directory, "work"),
          temporary = join(directory, "tmp");
        await mkdir(work, { recursive: true });
        await mkdir(temporary, { recursive: true });
        guest = {
          session: {
            id: randomUUID(),
            generation: 1,
            name,
            state: "running",
            program: agent.program,
            machine: agent.machine,
            machineRevision: agent.machineRevision,
            repos: [],
          },
          work,
          temporary,
          jobs: new Map(),
          captures: new Map(),
        };
        guests.set(name, guest);
        await options.beforeStart?.(guest.session);
        respond(response, 200, guest.session);
        return;
      }
      if (!guest) {
        respond(response, 404, { error: "No such session" });
        return;
      }
      if (suffix === "" && method === "GET") {
        respond(response, 200, guest.session);
        return;
      }
      if (suffix === "/suspend") {
        const expected = JSON.parse((await body(request)).toString());
        if (expected.id !== guest.session.id || expected.generation !== guest.session.generation) {
          respond(response, 409, { error: "Changed execution" });
          return;
        }
        if (guest.session.state !== "running") {
          respond(response, 409, { error: "Session is not running" });
          return;
        }
        guest.session.state = "suspended";
        respond(response, 200, null);
        return;
      }
      if (
        request.headers["bay-session-id"] !== guest.session.id ||
        request.headers["bay-session-generation"] !== String(guest.session.generation)
      ) {
        respond(response, 409, { error: "Changed execution" });
        return;
      }
      response.setHeader("Bay-Session-ID", guest.session.id);
      response.setHeader("Bay-Session-Generation", String(guest.session.generation));
      if (suffix === "/environment") {
        if (request.headers["bay-machine-revision"] !== guest.session.machineRevision) {
          respond(response, 409, { error: "Changed machine" });
          return;
        }
        response.setHeader("Bay-Machine-Revision", guest.session.machineRevision);
        await environment(request, response, guest);
        return;
      }
      const blob = /^\/blobs\/([a-f0-9]{64})$/.exec(suffix);
      if (blob) {
        const bytes = await body(request);
        if (digest(bytes) !== blob[1]) throw new Error("Wrong blob digest");
        const path = join(root, "blobs", blob[1]!);
        await mkdir(join(root, "blobs"), { recursive: true });
        const file = await open(path, "w");
        await file.writeFile(bytes);
        await file.close();
        respond(response, 200, { sha256: blob[1], size: bytes.length, path });
        return;
      }
      const job = /^\/jobs\/([^/]+)$/.exec(suffix);
      if (job) {
        const id = decodeURIComponent(job[1]!);
        let receipt = guest.jobs.get(id);
        if (method === "POST") {
          const command = JSON.parse((await body(request)).toString()) as BayCommand;
          if (receipt) {
            if (
              JSON.stringify(command) !==
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(receipt).filter(([name]) =>
                    ["argv", "cwd", "timeoutMs", "maxOutputBytes", "machineRevision", "inputDigest"].includes(
                      name,
                    ),
                  ),
                ),
              )
            )
              throw new Error("Job payload changed");
          } else {
            if (command.machineRevision !== guest.session.machineRevision)
              throw new Error("Job machine changed");
            receipt = {
              ...command,
              id,
              recordId: guest.session.id,
              generation: guest.session.generation,
              status: "running",
              stdout: "",
              stderr: "",
              exitCode: null,
            };
            guest.jobs.set(id, receipt);
            dispatches.set(id, (dispatches.get(id) ?? 0) + 1);
            const target = receipt;
            const selected = guest;
            void Promise.resolve()
              .then(() => options.beforeJob?.(selected.session, command))
              .then(() =>
                execute(
                  selected,
                  command.argv,
                  resolve(selected.work, command.cwd),
                  command.timeoutMs,
                  command.maxOutputBytes,
                ),
              )
              .then((result) =>
                Object.assign(target, result, {
                  status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "succeeded" : "failed",
                }),
              )
              .catch((error) =>
                Object.assign(target, { status: "failed", error: String(error), exitCode: -1 }),
              );
          }
        }
        if (!receipt) {
          respond(response, 404, { error: "No job" });
          return;
        }
        respond(response, 200, receipt);
        return;
      }
      const capture = /^\/captures\/([^/]+)$/.exec(suffix);
      if (capture) {
        const id = decodeURIComponent(capture[1]!);
        let bytes = guest.captures.get(id);
        if (method === "POST") {
          const input = JSON.parse((await body(request)).toString());
          if (!bytes) {
            bytes = await readFile(resolve(guest.work, input.path));
            if (bytes.length > input.maxBytes) throw new Error("Capture too large");
            guest.captures.set(id, bytes);
          }
          respond(response, 200, { sha256: digest(bytes), size: bytes.length, path: "/captures/" + id });
          return;
        }
        if (!bytes) {
          respond(response, 404, { error: "No capture" });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Bay-Content-SHA256": digest(bytes),
        });
        response.end(bytes);
        return;
      }
      respond(response, 404, { error: "No fixture route " + suffix });
    })().catch((error) => {
      if (!response.headersSent) respond(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    catalog,
    guests,
    dispatches,
    environmentOperations,
    close: async () => {
      await Promise.allSettled([...links].map((close) => close()));
      for (const command of running) stop(command);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
