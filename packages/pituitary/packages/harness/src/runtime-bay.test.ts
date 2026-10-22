import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSessionState, type RpcSessionState } from "@pituitary/rpc";
import type { BaySession } from "./bay.ts";
import { parseCatalog } from "./catalog.ts";
import { agentManifestDigest, type ClientRecord, WorkerRecordDecoder } from "./protocol.ts";
import { rootAttempt, waitRun } from "./runtime.fixture.ts";
import { Runtime } from "./runtime.ts";
import { startRuntime } from "./supervisor.ts";
import { startWorker, type Worker } from "./worker.ts";
import { connectWorker } from "./worker-client.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Bay fixture cleanup failed");
});

const declaration = {
  schemaVersion: 1,
  name: "builder",
  description: "Build a change",
  instructions: "Implement the requested change and preserve the existing behavior.",
  model: null,
  tools: ["read", "bash"],
  delegatesTo: [],
  credentials: [],
  program: "pituitary-builder",
  machine: "pituitary-builder",
  machineRevision: "machine-revision-1",
};

/** Real worker framing, role binding and native history; only the VM boundary is simulated. */
async function fixture(
  options: {
    loseStartReply?: boolean;
    losePromptReply?: boolean;
    scriptedPrompt?: boolean;
    legacy?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-bay-"));
  const socket = join(root, "bay.sock");
  const command = join(root, "bay-fixture");
  const catalogFile = join(root, "catalog.json");
  const stateDirectory = join(root, "runs");
  const workerSocket = join(root, "worker.sock");
  const workspace = join(root, "guest-workspace");
  const guestState = join(root, "guest-state");
  mkdirSync(workspace);
  const catalogData = { schemaVersion: 1, baySocket: socket, agents: { builder: declaration } };
  writeFileSync(catalogFile, JSON.stringify(catalogData));
  // The fixture command mirrors `bay connect`: protocol bytes alone on stdout, identity in a header.
  writeFileSync(
    command,
    `#!${process.execPath}
import { request } from "node:http";
const [verb, name, flag, id, generationFlag, generation] = process.argv.slice(2);
if (verb !== "connect" || flag !== "--id" || !id || generationFlag !== "--generation" || !generation) process.exit(2);
const req = request({ socketPath: process.env.BAY_SOCKET, method: "POST",
  path: "/v1/sessions/" + encodeURIComponent(name) + "/connect",
  headers: { "Bay-Session-ID": id, "Bay-Session-Generation": generation, "Content-Type": "application/octet-stream" } });
req.on("response", response => {
  if (response.statusCode !== 200 || response.headers["bay-session-id"] !== id || response.headers["bay-session-generation"] !== generation) {
    response.resume(); console.error("Bay session identity rejected"); process.exitCode = 1; req.destroy(); return;
  }
  response.pipe(process.stdout);
  response.on("end", () => { process.stdin.unpipe(req); process.stdin.pause(); req.end(); });
});
req.on("error", error => { console.error(error.message); process.exitCode = 1; process.stdin.pause(); });
process.stdin.pipe(req);
`,
    { mode: 0o700 },
  );
  let worker: Worker | undefined;
  let session: BaySession | undefined;
  let observation: Partial<BaySession> = {};
  let promptCount = 0;
  let promptReplyLost = false;
  let recoveryAllowed = !options.loseStartReply;
  const connections = new Set<Socket>();
  const starts: unknown[] = [];
  const ends: unknown[] = [];
  const suspends: unknown[] = [];
  const sent: ClientRecord[] = [];
  const state: RpcSessionState = { ...fakeSessionState, sessionId: randomUUID() };
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith("/v1/messages/feed")) {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ messages: [], next: "0", more: false }));
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(\/start|\/end|\/suspend|\/connect)?$/.exec(request.url ?? "");
      if (!match) {
        response.writeHead(404).end("{}");
        return;
      }
      const name = decodeURIComponent(match[1] ?? "");
      if (match[2] === "/connect") {
        if (
          !session ||
          session.name !== name ||
          session.id !== request.headers["bay-session-id"] ||
          String(session.generation) !== request.headers["bay-session-generation"] ||
          session.state !== "running"
        ) {
          response.writeHead(409).end(JSON.stringify({ error: "record identity changed" }));
          return;
        }
        const guest = connect(workerSocket);
        connections.add(guest);
        guest.once("close", () => connections.delete(guest));
        guest.on("error", () => response.destroy());
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Bay-Session-ID": session.id,
          "Bay-Session-Generation": String(session.generation),
        });
        response.flushHeaders();
        const input = new WorkerRecordDecoder();
        request.on("data", (chunk: Buffer) => {
          for (const line of input.push(chunk)) sent.push(JSON.parse(line) as ClientRecord);
        });
        request.pipe(guest);
        if (options.losePromptReply && !promptReplyLost) {
          const decoder = new WorkerRecordDecoder();
          guest.on("data", (chunk: Buffer) => {
            for (const line of decoder.push(chunk)) {
              const record = JSON.parse(line) as { type: string; id?: string; success?: boolean };
              if (record.type === "result" && record.success && record.id?.endsWith(":initial")) {
                promptReplyLost = true;
                response.destroy();
                guest.destroy();
                return;
              }
              response.write(`${line}\n`);
            }
          });
          guest.once("end", () => response.end());
        } else {
          guest.pipe(response);
        }
        request.once("aborted", () => guest.destroy());
        response.once("close", () => guest.destroy());
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      response.setHeader("Content-Type", "application/json");
      if (match[2] === "/start") {
        starts.push(body);
        if (session) {
          response.writeHead(409).end(JSON.stringify({ error: "already exists" }));
          return;
        }
        worker = await startWorker({
          socketPath: workerSocket,
          stateDirectory: guestState,
          cwd: workspace,
          roleRequired: true,
          configDirectory: join(root, "guest-config"),
          authFile: join(root, "no-credentials.json"),
          ...(options.scriptedPrompt
            ? {
                engineFactory: async (context) => ({
                  call: async (command) => {
                    if (command.type === "get_state") return { ...state };
                    if (command.type === "set_session_name") {
                      state.sessionName = command.name;
                      return;
                    }
                    if (command.type === "prompt") {
                      promptCount++;
                      context.onEvent({ type: "agent_settled" });
                      return;
                    }
                    if (command.type === "get_messages") return { messages: [] };
                    throw new Error(`Unexpected fixture command ${command.type}`);
                  },
                  respond: () => {},
                  close: async () => {},
                }),
              }
            : {}),
        });
        session = {
          id: randomUUID(),
          generation: 1,
          name,
          state: "running",
          program: declaration.program,
          machine: declaration.machine,
          machineRevision: declaration.machineRevision,
          repos: [{ owner: "owner", name: "repo", commit: "0123456789abcdef0123456789abcdef01234567" }],
        };
        if (options.loseStartReply) {
          response.destroy();
          return;
        }
        response.end(JSON.stringify(session));
      } else if (!session || session.name !== name) {
        response.writeHead(404).end(JSON.stringify({ error: "No such session" }));
      } else if (match[2] === "/end" || match[2] === "/suspend") {
        const ending = match[2] === "/end";
        (ending ? ends : suspends).push(body);
        const current = { ...session, ...observation };
        if (
          (body as { id?: string; generation?: number }).id !== current.id ||
          (body as { generation?: number }).generation !== current.generation
        ) {
          response.writeHead(409).end(JSON.stringify({ error: "record identity changed" }));
          return;
        }
        await worker?.close();
        if (ending) {
          rmSync(workspace, { recursive: true });
          rmSync(guestState, { recursive: true });
        }
        session = { ...session, state: ending ? "ended" : "suspended" };
        response.end(JSON.stringify(session));
      } else if (!recoveryAllowed) {
        response.writeHead(503).end(JSON.stringify({ error: "Fixture recovery is paused" }));
      } else {
        response.end(JSON.stringify({ ...session, ...observation }));
      }
    } catch (error) {
      response
        .writeHead(500)
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(async () => {
    try {
      await worker?.close();
    } finally {
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  let legacy: { sessionId: string; incarnation: string; sessionFile?: string } | undefined;
  if (options.legacy) {
    const { Bay } = await import("./bay.ts");
    const definition = parseCatalog(catalogData).agents.builder;
    if (!definition) throw new Error("Missing legacy fixture role");
    const existing = await new Bay(socket, command).start("legacy-build", definition, []);
    const client = await connectWorker(workerSocket);
    try {
      await client.request({ type: "initialize", manifest: definition.manifest });
      await client.bash(
        "legacy-work",
        "printf 'history before orchestration'; printf 'retained legacy work' > result.txt",
        false,
      );
      const state = await client.getState();
      legacy = {
        sessionId: state.sessionId,
        incarnation: client.identity.incarnation,
        sessionFile: state.sessionFile,
      };
    } finally {
      await client.close();
    }
    mkdirSync(stateDirectory, { mode: 0o700 });
    const old = new Database(join(stateDirectory, "runs.sqlite"));
    try {
      old.exec(
        "CREATE TABLE runs (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,cwd TEXT NOT NULL,directory TEXT NOT NULL,socket TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,session_id TEXT,pid INTEGER,prompt TEXT,prompt_status TEXT,error TEXT,execution TEXT NOT NULL,desired TEXT NOT NULL); PRAGMA user_version=3;",
      );
      old
        .query("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          "legacy-run",
          "legacy-build",
          root,
          join(stateDirectory, "legacy-attempt"),
          workerSocket,
          "ready",
          "2026-10-22",
          legacy.sessionId,
          process.pid,
          null,
          null,
          null,
          JSON.stringify({
            kind: "bay",
            socket,
            command,
            sessionName: existing.name,
            recordId: existing.id,
            agent: definition,
            repos: [],
          }),
          "running",
        );
    } finally {
      old.close();
    }
  }
  const host = await startRuntime({ stateDirectory, catalogFile, bayCommand: command, startupTimeout: 3000 });
  cleanup.push(() => host.close());
  const runtime = () => {
    const created = new Runtime({ stateDirectory, autoStart: false });
    cleanup.push(() => created.close());
    return created;
  };
  return {
    root,
    workspace,
    runtime,
    catalogData,
    catalogFile,
    starts,
    ends,
    suspends,
    sent,
    legacy,
    guestState,
    get session() {
      return session;
    },
    get promptCount() {
      return promptCount;
    },
    observe(changes: Partial<BaySession>) {
      observation = changes;
      for (const connection of connections) connection.destroy();
    },
    closeWorker: () => worker?.close(),
    allowRecovery() {
      recoveryAllowed = true;
    },
  };
}

test("a schema-three Bay conversation reconnects with its original role and history without gaining orchestration", async () => {
  const environment = await fixture({ legacy: true });
  const runtime = environment.runtime();
  const original = environment.legacy;
  if (!original) throw new Error("Missing saved legacy conversation");
  const detail = await waitRun(runtime, "legacy-build", (item) => rootAttempt(item).status === "ready");
  const attempt = rootAttempt(detail);
  expect(attempt.grant).toEqual({ orchestration: false, maxChildren: 0, maxDepth: 0 });
  expect(attempt.sessionId).toBe(original.sessionId);
  expect(attempt.incarnation).toBe(original.incarnation);
  const attached = await runtime.attach(detail.run.id);
  try {
    expect(attached.identity.assignment).toBeUndefined();
    expect(JSON.stringify(await attached.getMessages())).toContain("history before orchestration");
    expect(attached.identity.roleDigest).toBe(
      agentManifestDigest(
        parseCatalog(environment.catalogData).agents.builder
          ?.manifest as import("./protocol.ts").AgentManifest,
      ),
    );
  } finally {
    await attached.close();
  }
  expect(environment.sent.some((record) => record.type === "credentials")).toBe(false);
  const initializations = environment.sent.filter(
    (record) => record.type === "command" && record.command.type === "initialize",
  );
  expect(initializations).toHaveLength(1);
  expect(initializations[0]).not.toHaveProperty("command.assignment");
  expect(existsSync(join(environment.guestState, "assignment.json"))).toBe(false);
  expect(environment.starts).toHaveLength(1);
  await runtime.recover(detail.run.id);
  await waitRun(runtime, detail.run.id, (item) => rootAttempt(item).status === "ready");
  expect(environment.starts).toHaveLength(1);
  await runtime.stop(detail.run.id);
  await waitRun(runtime, detail.run.id, (item) => rootAttempt(item).status === "stopped");
  expect(environment.suspends).toHaveLength(1);
  expect(readFileSync(join(environment.workspace, "result.txt"), "utf8")).toBe("retained legacy work");
  expect(readFileSync(original.sessionFile as string, "utf8")).toContain("history before orchestration");
});

test("a Bay run reconnects to its frozen declaration and native history after the catalog changes", async () => {
  const environment = await fixture();
  const runtime = environment.runtime();
  const run = await runtime.start({
    name: "build",
    cwd: environment.root,
    agent: "builder",
    repos: ["owner/repo@pinned-ref"],
  });
  const initial = await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready");
  const attempt = rootAttempt(initial);
  if (attempt.execution.kind !== "bay") throw new Error("Expected Bay execution");
  const session = environment.session;
  if (!session) throw new Error("Expected Bay session");
  expect(attempt.execution.recordId).toBe(session.id);
  expect(attempt.execution.generation).toBe(session.generation);
  expect(initial.run.repos).toEqual(["owner/repo@0123456789abcdef0123456789abcdef01234567"]);
  expect(environment.starts).toEqual([
    {
      program: declaration.program,
      machineRevision: declaration.machineRevision,
      repos: ["owner/repo@pinned-ref"],
    },
  ]);
  const first = await runtime.attach(run.id);
  try {
    await first.bash(
      "durable-shell",
      "printf 'saved guest history'; printf 'unexported result' > result.txt",
      false,
    );
  } finally {
    await first.close();
  }
  writeFileSync(
    environment.catalogFile,
    JSON.stringify({
      ...environment.catalogData,
      agents: {
        builder: { ...declaration, instructions: "A different role", machineRevision: "machine-revision-2" },
      },
    }),
  );
  const resumed = environment.runtime();
  const inspected = await resumed.inspect(run.id);
  expect(rootAttempt(inspected).sessionId).toBe(attempt.sessionId);
  expect(rootAttempt(inspected).execution).toEqual(attempt.execution);
  const second = await resumed.attach(run.id);
  const nativeSession = second.identity.sessionFile;
  if (!nativeSession) throw new Error("Expected saved native history");
  try {
    expect(second.identity.roleDigest).toBe(agentManifestDigest(attempt.execution.agent.manifest));
    expect(JSON.stringify(await second.getMessages())).toContain("saved guest history");
    expect(readFileSync(nativeSession, "utf8")).toContain("saved guest history");
  } finally {
    await second.close();
  }
  expect((await resumed.stop(run.id)).desired).toBe("stopped");
  await waitRun(resumed, run.id, (detail) => rootAttempt(detail).status === "stopped");
  expect(environment.suspends).toEqual([{ id: session.id, generation: session.generation }]);
  expect(environment.ends).toEqual([]);
  expect(environment.session?.state).toBe("suspended");
  expect(readFileSync(join(environment.workspace, "result.txt"), "utf8")).toBe("unexported result");
  expect(readFileSync(nativeSession, "utf8")).toContain("saved guest history");
  expect(
    JSON.parse(readFileSync(join(environment.root, "guest-state", "worker.json"), "utf8")),
  ).toMatchObject({ sessionId: attempt.sessionId });
  await resumed.stop(run.id);
  expect(environment.suspends).toHaveLength(1);
  expect(environment.starts).toHaveLength(1);
});

test("reconnection rejects replaced Bay identity and stopping never acts on its replacement", async () => {
  for (const field of ["id", "name", "program", "machine", "machineRevision", "generation"] as const) {
    const environment = await fixture();
    const runtime = environment.runtime();
    const run = await runtime.start({ name: "identity", cwd: environment.root, agent: "builder" });
    await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready");
    environment.observe({ [field]: field === "generation" ? 2 : "replaced" });
    const refused = await waitRun(
      runtime,
      run.id,
      (detail) =>
        detail.tasks[0]?.status === "failed" &&
        (rootAttempt(detail).error?.includes("identity or machine changed") ?? false),
    );
    expect(refused.run.desired).toBe("stopped");
    expect(rootAttempt(refused).desired).toBe("stopped");
    expect(environment.ends).toEqual([]);
    expect(environment.suspends).toEqual([]);
    await expect(runtime.recover(run.id)).rejects.toThrow("Stopped runs");
    environment.observe({});
    await runtime.stop(run.id);
    await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
    expect(environment.suspends).toHaveLength(1);
    expect(environment.ends).toEqual([]);
  }
}, 30_000);

test("explicit recovery adopts a lost launch response without launching or prompting twice", async () => {
  const environment = await fixture({ loseStartReply: true, scriptedPrompt: true });
  const runtime = environment.runtime();
  const run = await runtime.start({
    name: "recover",
    cwd: environment.root,
    agent: "builder",
    prompt: "Implement once",
  });
  const saved = rootAttempt(
    await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "unreachable"),
  );
  expect(saved.promptStatus).toBe("pending");
  expect(environment.starts).toHaveLength(1);
  expect(rootAttempt(await runtime.inspect(run.id)).status).toBe("unreachable");
  expect(environment.promptCount).toBe(0);
  environment.allowRecovery();
  await runtime.recover(run.id);
  const recovered = rootAttempt(
    await waitRun(runtime, run.id, (detail) => rootAttempt(detail).promptStatus === "accepted"),
  );
  expect(recovered.status).toBe("ready");
  expect(environment.promptCount).toBe(1);
  await runtime.recover(run.id);
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "ready");
  expect(environment.promptCount).toBe(1);
  expect(environment.starts).toHaveLength(1);
  await runtime.stop(run.id);
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
});

test("recovery reconciles a lost prompt acknowledgment through its saved receipt", async () => {
  const environment = await fixture({ losePromptReply: true, scriptedPrompt: true });
  const runtime = environment.runtime();
  const run = await runtime.start({
    name: "prompt-receipt",
    cwd: environment.root,
    agent: "builder",
    prompt: "Implement once",
  });
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).promptStatus === "uncertain");
  expect(environment.promptCount).toBe(1);
  await runtime.recover(run.id);
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).promptStatus === "accepted");
  expect(environment.promptCount).toBe(1);
  expect(environment.starts).toHaveLength(1);
  await runtime.stop(run.id);
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
});

test("stopping a lost launch does not require configuring or reaching its worker", async () => {
  const environment = await fixture({ loseStartReply: true });
  const runtime = environment.runtime();
  const run = await runtime.start({ name: "unready", cwd: environment.root, agent: "builder" });
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "unreachable");
  await environment.closeWorker();
  environment.allowRecovery();
  await runtime.stop(run.id);
  await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
  expect(environment.suspends).toEqual([
    { id: environment.session?.id, generation: environment.session?.generation },
  ]);
  expect(environment.ends).toEqual([]);
  expect(environment.starts).toHaveLength(1);
});

test("unknown declarations fail before reserving a run or calling Bay", async () => {
  const environment = await fixture();
  const runtime = environment.runtime();
  await expect(runtime.start({ name: "unknown", cwd: environment.root, agent: "missing" })).rejects.toThrow(
    "No declared agent",
  );
  expect(await runtime.list()).toEqual([]);
  expect(environment.starts).toEqual([]);
  expect(parseCatalog(environment.catalogData).agents.builder?.manifest.name).toBe("builder");
});
