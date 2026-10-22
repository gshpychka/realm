import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSessionState, type RpcSessionState } from "@pituitary/rpc";
import type { BaySession } from "./bay.ts";
import { parseCatalog } from "./catalog.ts";
import { agentManifestDigest, WorkerRecordDecoder } from "./protocol.ts";
import { Runtime } from "./runtime.ts";
import { startWorker, type Worker } from "./worker.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
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
  options: { loseStartReply?: boolean; losePromptReply?: boolean; scriptedPrompt?: boolean } = {},
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
const [verb, name, flag, id] = process.argv.slice(2);
if (verb !== "connect" || flag !== "--id" || !id) process.exit(2);
const req = request({ socketPath: process.env.BAY_SOCKET, method: "POST",
  path: "/v1/sessions/" + encodeURIComponent(name) + "/connect",
  headers: { "Bay-Session-ID": id, "Content-Type": "application/octet-stream" } });
req.on("response", response => {
  if (response.statusCode !== 200 || response.headers["bay-session-id"] !== id) {
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
  const starts: unknown[] = [];
  const ends: unknown[] = [];
  const suspends: unknown[] = [];
  const state: RpcSessionState = { ...fakeSessionState, sessionId: randomUUID() };
  const server = createServer(async (request, response) => {
    try {
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
          session.state !== "running"
        ) {
          response.writeHead(409).end(JSON.stringify({ error: "record identity changed" }));
          return;
        }
        const guest = connect(workerSocket);
        guest.on("error", () => response.destroy());
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Bay-Session-ID": session.id });
        response.flushHeaders();
        request.pipe(guest);
        if (options.losePromptReply && !promptReplyLost) {
          const decoder = new WorkerRecordDecoder();
          guest.on("data", (chunk: Buffer) => {
            for (const line of decoder.push(chunk)) {
              const record = JSON.parse(line) as { type: string; id?: string; success?: boolean };
              if (record.type === "result" && record.success && record.id?.endsWith("-initial")) {
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
          name,
          state: "running",
          program: declaration.program,
          machine: declaration.machine,
          machineRevision: declaration.machineRevision,
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
        if ((body as { id?: string }).id !== session.id) {
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
    await worker?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const runtime = () => {
    const created = new Runtime({ stateDirectory, catalogFile, bayCommand: command, startupTimeout: 3000 });
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
    get session() {
      return session;
    },
    get promptCount() {
      return promptCount;
    },
    observe(changes: Partial<BaySession>) {
      observation = changes;
    },
    closeWorker: () => worker?.close(),
  };
}

test("a Bay run reconnects to its frozen declaration and native history after the catalog changes", async () => {
  const environment = await fixture();
  const runtime = environment.runtime();
  const run = await runtime.start({
    name: "build",
    cwd: environment.root,
    agent: "builder",
    repos: ["owner/repo@pinned-ref"],
  });
  expect(run.status).toBe("ready");
  if (run.execution.kind !== "bay") throw new Error("Expected Bay execution");
  const session = environment.session;
  if (!session) throw new Error("Expected Bay session");
  expect(run.execution.recordId).toBe(session.id);
  expect(environment.starts).toEqual([
    {
      program: declaration.program,
      machineRevision: declaration.machineRevision,
      repos: ["owner/repo@pinned-ref"],
    },
  ]);
  const first = await runtime.connect(run, true);
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
  expect(inspected.sessionId).toBe(run.sessionId);
  expect(inspected.status).toBe("ready");
  const second = await resumed.connect(inspected, true);
  const nativeSession = second.identity.sessionFile;
  if (!nativeSession) throw new Error("Expected saved native history");
  try {
    expect(second.identity.roleDigest).toBe(agentManifestDigest(run.execution.agent.manifest));
    expect(JSON.stringify(await second.getMessages())).toContain("saved guest history");
    expect(readFileSync(second.identity.sessionFile as string, "utf8")).toContain("saved guest history");
  } finally {
    await second.close();
  }
  expect((await resumed.stop(run.id)).status).toBe("stopped");
  expect(environment.suspends).toEqual([{ id: run.execution.recordId }]);
  expect(environment.ends).toEqual([]);
  expect(environment.session?.state).toBe("suspended");
  expect(readFileSync(join(environment.workspace, "result.txt"), "utf8")).toBe("unexported result");
  expect(readFileSync(nativeSession, "utf8")).toContain("saved guest history");
  expect(
    JSON.parse(readFileSync(join(environment.root, "guest-state", "worker.json"), "utf8")),
  ).toMatchObject({ sessionId: run.sessionId });
  expect((await resumed.stop(run.id)).status).toBe("stopped");
  expect(environment.suspends).toHaveLength(1);
  expect(environment.starts).toHaveLength(1);
});

test("observation rejects a replaced Bay record or machine instead of attaching by name", async () => {
  const environment = await fixture();
  const runtime = environment.runtime();
  const run = await runtime.start({ name: "identity", cwd: environment.root, agent: "builder" });
  for (const field of ["id", "name", "program", "machine", "machineRevision"] as const) {
    environment.observe({ [field]: "replaced" });
    const inspected = await runtime.inspect(run.id);
    expect(inspected.status).toBe("unreachable");
    expect(inspected.error).toContain("identity or machine changed");
    await expect(runtime.connect(run, true)).rejects.toThrow("identity or machine changed");
    expect(environment.ends).toHaveLength(0);
    expect(environment.suspends).toHaveLength(0);
  }
  await expect(runtime.stop(run.id)).rejects.toThrow("identity or machine changed");
  environment.observe({});
  expect((await runtime.stop(run.id)).status).toBe("stopped");
  expect(environment.suspends).toHaveLength(1);
  expect(environment.ends).toEqual([]);
});

test("explicit recovery adopts a lost launch response without launching or prompting twice", async () => {
  const environment = await fixture({ loseStartReply: true, scriptedPrompt: true });
  const runtime = environment.runtime();
  await expect(
    runtime.start({ name: "recover", cwd: environment.root, agent: "builder", prompt: "Implement once" }),
  ).rejects.toThrow("Could not start");
  const saved = runtime.store.get("recover");
  expect(saved.status).toBe("unreachable");
  expect(saved.promptStatus).toBe("pending");
  expect(environment.starts).toHaveLength(1);
  expect((await runtime.inspect(saved.id)).status).toBe("unreachable");
  expect(environment.promptCount).toBe(0);
  const recovered = await runtime.recover(saved.id);
  expect(recovered.status).toBe("ready");
  expect(recovered.promptStatus).toBe("accepted");
  expect(environment.promptCount).toBe(1);
  await runtime.recover(saved.id);
  expect(environment.promptCount).toBe(1);
  expect(environment.starts).toHaveLength(1);
  await runtime.stop(saved.id);
});

test("recovery reconciles a lost prompt acknowledgment through its saved receipt", async () => {
  const environment = await fixture({ losePromptReply: true, scriptedPrompt: true });
  const runtime = environment.runtime();
  await expect(
    runtime.start({
      name: "prompt-receipt",
      cwd: environment.root,
      agent: "builder",
      prompt: "Implement once",
    }),
  ).rejects.toThrow("Could not start");
  const saved = runtime.store.get("prompt-receipt");
  expect(saved.promptStatus).toBe("uncertain");
  expect(environment.promptCount).toBe(1);
  const recovered = await runtime.recover(saved.id);
  expect(recovered.promptStatus).toBe("accepted");
  expect(environment.promptCount).toBe(1);
  expect(environment.starts).toHaveLength(1);
  await runtime.stop(saved.id);
});

test("stopping a lost launch does not require configuring or reaching its worker", async () => {
  const environment = await fixture({ loseStartReply: true });
  const runtime = environment.runtime();
  await expect(runtime.start({ name: "unready", cwd: environment.root, agent: "builder" })).rejects.toThrow(
    "Could not start",
  );
  await environment.closeWorker();
  expect((await runtime.stop("unready")).status).toBe("stopped");
  expect(environment.suspends).toEqual([{ id: environment.session?.id }]);
  expect(environment.ends).toEqual([]);
  expect(environment.starts).toHaveLength(1);
});

test("unknown declarations fail before reserving a run or calling Bay", async () => {
  const environment = await fixture();
  const runtime = environment.runtime();
  await expect(runtime.start({ name: "unknown", cwd: environment.root, agent: "missing" })).rejects.toThrow(
    "No declared agent",
  );
  expect(runtime.store.list()).toEqual([]);
  expect(environment.starts).toEqual([]);
  expect(parseCatalog(environment.catalogData).agents.builder?.manifest.name).toBe("builder");
});
