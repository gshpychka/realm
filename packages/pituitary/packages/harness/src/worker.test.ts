import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSessionState, type RpcExtensionUIRequest, type RpcSessionState } from "@pituitary/rpc";
import type { DomainRequest, WorkerAssignment } from "./domain-protocol.ts";
import { type AgentManifest, agentManifestDigest } from "./protocol.ts";
import { startWorker, type Worker, type WorkerEngineContext } from "./worker.ts";
import { connectWorker, type WorkerClient } from "./worker-client.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-worker-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for worker");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function scripted() {
  let context!: WorkerEngineContext;
  let prompts = 0;
  let answers = 0;
  let closed = false;
  const state: RpcSessionState = { ...fakeSessionState };
  return {
    get context() {
      return context;
    },
    get prompts() {
      return prompts;
    },
    get answers() {
      return answers;
    },
    get closed() {
      return closed;
    },
    factory: async (next: WorkerEngineContext) => {
      context = next;
      return {
        call: async (command: import("@pituitary/rpc").RpcCommand): Promise<unknown> => {
          if (command.type === "get_state") return { ...state };
          if (command.type === "get_messages") return { messages: [] };
          if (command.type === "prompt") {
            prompts++;
            state.isStreaming = true;
            context.onEvent({ type: "agent_start" });
            return;
          }
          if (command.type === "abort") {
            state.isStreaming = false;
            context.onEvent({ type: "agent_settled" });
            return;
          }
          throw new Error(`unsupported scripted command: ${command.type}`);
        },
        respond: () => {
          answers++;
        },
        close: async () => {
          closed = true;
        },
      };
    },
  };
}

async function fakeWorker(root = directory()) {
  const engine = scripted();
  const options = {
    socketPath: join(root, "worker.sock"),
    stateDirectory: root,
    cwd: root,
    engineFactory: engine.factory,
  };
  const worker = await startWorker(options);
  cleanup.push(() => worker.close());
  return { root, engine, worker, options };
}

async function client(worker: Worker, control = true): Promise<WorkerClient> {
  const connected = await connectWorker(worker.socketPath, { control });
  cleanup.push(() => connected.close());
  return connected;
}

const reviewer: AgentManifest = {
  schemaVersion: 1,
  name: "reviewer",
  description: "Review changes",
  instructions: "Read the exact change and report concrete bugs.",
  model: null,
  tools: ["read", "grep"],
  delegatesTo: [],
  credentials: ["models"],
};

test("a managed worker binds its role before creating Pi and survives restart unchanged", async () => {
  const root = directory();
  const engine = scripted();
  let creations = 0;
  const options = {
    socketPath: join(root, "worker.sock"),
    stateDirectory: root,
    cwd: root,
    roleRequired: true,
    engineFactory: async (context: WorkerEngineContext) => {
      creations++;
      return engine.factory(context);
    },
  };
  const worker = await startWorker(options);
  cleanup.push(() => worker.close());
  const first = await client(worker);
  expect(creations).toBe(0);
  await expect(first.prompt("too early")).rejects.toThrow("requires an agent role");
  const initialize = { type: "initialize" as const, manifest: reviewer };
  expect(await first.request(initialize, "initialize")).toMatchObject({
    roleDigest: agentManifestDigest(reviewer),
    sessionId: fakeSessionState.sessionId,
  });
  expect(creations).toBe(1);
  expect(engine.context.role).toEqual(reviewer);
  expect(engine.context.instructions).toBe(reviewer.instructions);
  expect(worker.identity.roleDigest).toBe(agentManifestDigest(reviewer));
  expect(statSync(join(root, "role.json")).mode & 0o777).toBe(0o600);
  await first.request(initialize, "initialize");
  expect(creations).toBe(1);
  await expect(
    first.request({ ...initialize, manifest: { ...reviewer, instructions: "changed" } }),
  ).rejects.toThrow("another agent role");
  await first.close();
  await worker.close();
  const replacement = await startWorker(options);
  cleanup.push(() => replacement.close());
  expect(creations).toBe(1);
  const second = await client(replacement);
  expect(second.identity.roleDigest).toBe(agentManifestDigest(reviewer));
  await second.request(initialize, "initialize");
  expect(creations).toBe(2);
  await second.prompt("review now");
  expect(engine.prompts).toBe(1);
});

const assignment: WorkerAssignment = { runId: "run-1", taskId: "task-1", attemptId: "attempt-1", epoch: 1 };

test("supervised requests survive detach and restart with stable receipts while credentials stay in RAM", async () => {
  const root = directory();
  const engine = scripted();
  let creations = 0;
  const options = {
    socketPath: join(root, "worker.sock"),
    stateDirectory: root,
    cwd: root,
    roleRequired: true,
    engineFactory: async (context: WorkerEngineContext) => {
      creations++;
      return engine.factory(context);
    },
  };
  let worker = await startWorker(options);
  cleanup.push(() => worker.close());
  let supervisor = await connectWorker(worker.socketPath, { supervisor: true });
  cleanup.push(() => supervisor.close());
  await expect(supervisor.request({ type: "initialize", manifest: reviewer, assignment })).rejects.toThrow(
    "provision credentials",
  );
  await supervisor.provision({ anthropic: "fixture-secret-never-persist" });
  await supervisor.request({ type: "initialize", manifest: reviewer, assignment });
  expect(supervisor.identity.assignment).toEqual(assignment);
  expect(engine.context.apiKeys).toEqual({ anthropic: "fixture-secret-never-persist" });
  await expect(
    supervisor.request({ type: "initialize", manifest: reviewer, assignment: { ...assignment, epoch: 2 } }),
  ).rejects.toThrow("another attempt");
  const requests: DomainRequest[] = [];
  supervisor.onDomainRequest((request) => requests.push(request));
  const domain = engine.context.domain;
  if (!domain) throw new Error("Missing supervisor domain channel");
  const pending = domain("assistant-entry", "message-call", {
    type: "message",
    to: "parent",
    body: "A question",
  });
  await waitFor(() => requests.length === 1);
  const first = requests[0];
  if (!first) throw new Error("Missing domain request");
  await supervisor.close();
  supervisor = await connectWorker(worker.socketPath, { supervisor: true });
  const replay: DomainRequest[] = [];
  supervisor.onDomainRequest((request) => replay.push(request));
  await waitFor(() => replay.length === 1);
  expect(replay).toEqual([first]);
  supervisor.answerDomain({
    type: "domain_result",
    id: first.id,
    success: true,
    data: { messageId: "mail-1" },
  });
  expect(await pending).toEqual({ messageId: "mail-1" });
  expect(
    await domain("assistant-entry", "message-call", { type: "message", to: "parent", body: "A question" }),
  ).toEqual({ messageId: "mail-1" });
  await expect(
    domain("assistant-entry", "message-call", { type: "message", to: "parent", body: "Changed" }),
  ).rejects.toThrow("another payload");
  const interrupted = domain("assistant-entry", "second-call", {
    type: "yield",
    reason: "Waiting for the answer",
  }).catch((error: unknown) => error);
  await waitFor(() => replay.length === 2);
  const waiting = replay[1];
  if (!waiting) throw new Error("Missing waiting request");
  await supervisor.close();
  await worker.close();
  expect(await interrupted).toBeInstanceOf(Error);
  worker = await startWorker(options);
  expect(creations).toBe(1);
  supervisor = await connectWorker(worker.socketPath, { supervisor: true });
  const resumed: DomainRequest[] = [];
  supervisor.onDomainRequest((request) => resumed.push(request));
  await waitFor(() => resumed.length === 1);
  expect(resumed).toEqual([waiting]);
  supervisor.answerDomain({ type: "domain_result", id: waiting.id, success: true, data: { waiting: true } });
  await expect(supervisor.request({ type: "initialize", manifest: reviewer, assignment })).rejects.toThrow(
    "provision credentials",
  );
  await supervisor.provision({ anthropic: "replacement-credential" });
  await supervisor.request({ type: "initialize", manifest: reviewer, assignment });
  expect(creations).toBe(2);
  expect(
    await engine.context.domain?.("assistant-entry", "second-call", {
      type: "yield",
      reason: "Waiting for the answer",
    }),
  ).toEqual({ waiting: true });
  for (const file of readdirSync(root))
    if (file.endsWith(".json")) {
      const saved = readFileSync(join(root, file), "utf8");
      expect(saved).not.toContain("fixture-secret-never-persist");
      expect(saved).not.toContain("replacement-credential");
    }
});

test("only the supervisor can provision auth or assign a worker", async () => {
  const root = directory();
  const worker = await startWorker({
    socketPath: join(root, "worker.sock"),
    stateDirectory: root,
    cwd: root,
    roleRequired: true,
    engineFactory: scripted().factory,
  });
  cleanup.push(() => worker.close());
  const controller = await client(worker);
  await expect(controller.request({ type: "initialize", manifest: reviewer, assignment })).rejects.toThrow(
    "supervisor lease",
  );
  await expect(controller.provision({ anthropic: "not-accepted" })).rejects.toThrow("only the supervisor");
});

test("a busy inbox rejection is retryable under the same delivery receipt ID", async () => {
  const root = directory();
  const engine = scripted();
  let busy = true;
  let delivered = 0;
  const worker = await startWorker({
    socketPath: join(root, "worker.sock"),
    stateDirectory: root,
    cwd: root,
    roleRequired: true,
    engineFactory: async (context) => ({
      ...(await engine.factory(context)),
      deliver: async () => {
        if (busy) throw new Error("worker is busy");
        delivered++;
        return { entryId: "native-inbox-entry", duplicate: false };
      },
      deliveryStatus: () => ({ entryId: delivered ? "native-inbox-entry" : null }),
    }),
  });
  cleanup.push(() => worker.close());
  const supervisor = await connectWorker(worker.socketPath, { supervisor: true });
  cleanup.push(() => supervisor.close());
  await supervisor.provision({});
  await supervisor.request({ type: "initialize", manifest: reviewer, assignment });
  const delivery = {
    type: "deliver" as const,
    batchId: "batch-1",
    messages: [{ id: "mail-1", from: "operator", body: "Continue" }],
    wake: true,
  };
  await expect(supervisor.request(delivery, "stable-delivery")).rejects.toThrow("busy");
  expect(await supervisor.request({ type: "get_delivery", batchId: "batch-1" })).toEqual({ entryId: null });
  busy = false;
  await supervisor.request(delivery, "stable-delivery");
  expect(delivered).toBe(1);
  expect(await supervisor.request({ type: "get_delivery", batchId: "batch-1" })).toEqual({
    entryId: "native-inbox-entry",
  });
  const receipts = existsSync(join(root, "commands.json"))
    ? readFileSync(join(root, "commands.json"), "utf8")
    : "";
  expect(receipts).not.toContain("stable-delivery");
});

test("role initialization requires the controller and cannot convert a local conversation", async () => {
  const { worker, options } = await fakeWorker();
  const observer = await client(worker, false);
  await expect(observer.request({ type: "initialize", manifest: reviewer })).rejects.toThrow(
    "does not control",
  );
  const controller = await client(worker);
  await expect(controller.request({ type: "initialize", manifest: reviewer })).rejects.toThrow(
    "local conversation",
  );
  await controller.close();
  await observer.close();
  await worker.close();
  await expect(startWorker({ ...options, roleRequired: true })).rejects.toThrow("saved local conversation");
});

test("missing or changed saved roles cannot silently alter a resumed native conversation", async () => {
  const root = directory();
  const options = {
    socketPath: join(root, "worker.sock"),
    stateDirectory: root,
    cwd: root,
    roleRequired: true,
    engineFactory: scripted().factory,
  };
  const worker = await startWorker(options);
  cleanup.push(() => worker.close());
  const controller = await client(worker);
  await controller.request({ type: "initialize", manifest: reviewer });
  await controller.close();
  await worker.close();
  writeFileSync(join(root, "role.json"), JSON.stringify({ ...reviewer, tools: ["bash"] }));
  await expect(startWorker(options)).rejects.toThrow("saved agent role changed");
  rmSync(join(root, "role.json"));
  await expect(startWorker(options)).rejects.toThrow("saved agent role is missing");
});

test("detaching releases input ownership and keeps the same running agent", async () => {
  const { worker, engine } = await fakeWorker();
  const first = await client(worker);
  await first.prompt("continue after I leave");
  expect((await first.getState()).isStreaming).toBe(true);
  const identity = first.identity;
  await first.close();
  expect(engine.closed).toBe(false);
  const second = await client(worker);
  expect(second.identity.incarnation).toBe(identity.incarnation);
  expect((await second.getState()).isStreaming).toBe(true);
  await second.abort();
  expect(engine.prompts).toBe(1);
});

test("stable command receipts deduplicate reconnects and reject changed payloads", async () => {
  const { worker, engine } = await fakeWorker();
  const first = await client(worker);
  await first.request({ type: "prompt", message: "once" }, "stable-prompt");
  await first.close();
  const second = await client(worker);
  await second.request({ type: "prompt", message: "once" }, "stable-prompt");
  expect(engine.prompts).toBe(1);
  await expect(second.request({ type: "prompt", message: "different" }, "stable-prompt")).rejects.toThrow(
    "another payload",
  );
});

test("receipts survive a worker incarnation change without reissuing mutations", async () => {
  const { worker, engine, options } = await fakeWorker();
  const first = await client(worker);
  await first.request({ type: "prompt", message: "once" }, "durable-prompt");
  const incarnation = first.identity.incarnation;
  await first.close();
  await worker.close();
  const replacement = await startWorker(options);
  cleanup.push(() => replacement.close());
  const second = await client(replacement);
  expect(second.identity.incarnation).not.toBe(incarnation);
  await second.request({ type: "prompt", message: "once" }, "durable-prompt");
  expect(engine.prompts).toBe(1);
});

test("an interrupted receipt stays uncertain instead of executing again", async () => {
  const root = directory();
  writeFileSync(
    join(root, "commands.json"),
    JSON.stringify([{ id: "interrupted", payload: '{"message":"once","type":"prompt"}' }]),
  );
  const { worker, engine } = await fakeWorker(root);
  const connected = await client(worker);
  await expect(connected.request({ type: "prompt", message: "once" }, "interrupted")).rejects.toThrow(
    "uncertain",
  );
  expect(engine.prompts).toBe(0);
});

test("ledger byte admission rejects an oversized durable command before executing it", async () => {
  const { worker, engine } = await fakeWorker();
  const connected = await client(worker);
  // Escaped content fits the wire limit but its canonical durable receipt exceeds the ledger budget.
  await expect(
    connected.request({ type: "prompt", message: '"'.repeat(4 * 1024 * 1024) }, "too-large"),
  ).rejects.toThrow("byte capacity");
  expect(engine.prompts).toBe(0);
});

test("one controller owns input; observers can inspect and explicitly stop", async () => {
  const { worker, engine } = await fakeWorker();
  await client(worker);
  await expect(connectWorker(worker.socketPath)).rejects.toThrow("another client controls");
  const observer = await client(worker, false);
  expect((await observer.getState()).sessionId).toBe("fake-session");
  await expect(observer.prompt("do not run")).rejects.toThrow("does not control");
  expect(engine.prompts).toBe(0);
  await observer.shutdown();
  await worker.stopped;
  expect(engine.closed).toBe(true);
});

test("pending operator dialogs remain available after the terminal detaches", async () => {
  const { worker, engine } = await fakeWorker();
  const first = await client(worker);
  engine.context.onUiRequest({
    type: "extension_ui_request",
    id: "question",
    method: "confirm",
    title: "Continue?",
    message: "Choose deliberately",
  });
  await first.close();
  const second = await client(worker);
  const requests: RpcExtensionUIRequest[] = [];
  second.onUiRequest((request) => requests.push(request));
  expect(requests[0]?.id).toBe("question");
  second.respond({ type: "extension_ui_response", id: "question", confirmed: true });
  await waitFor(() => engine.answers === 1);
  await second.close();
  const third = await client(worker);
  third.onUiRequest((request) => requests.push(request));
  expect(requests).toHaveLength(1);
});

test("attachment restores current display state without replaying historical editor actions", async () => {
  const { worker, engine } = await fakeWorker();
  for (let index = 0; index < 100; index++) {
    engine.context.onUiRequest({
      type: "extension_ui_request",
      id: `status-${index}`,
      method: "setStatus",
      statusKey: "progress",
      statusText: String(index),
    });
    engine.context.onUiRequest({
      type: "extension_ui_request",
      id: `draft-${index}`,
      method: "set_editor_text",
      text: "do not replay a past edit",
    });
  }
  const connected = await client(worker);
  const requests: RpcExtensionUIRequest[] = [];
  connected.onUiRequest((request) => requests.push(request));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ method: "setStatus", statusText: "99" });
});

test("resolved and expired dialogs do not reopen, and reconnect keeps the remaining timeout", async () => {
  const { worker, engine } = await fakeWorker();
  engine.context.onUiRequest({
    type: "extension_ui_request",
    id: "expired",
    method: "input",
    title: "Old question",
    timeout: 1,
  });
  engine.context.onUiRequest({
    type: "extension_ui_request",
    id: "pending",
    method: "input",
    title: "Current question",
    timeout: 5000,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const first = await client(worker);
  const requests: RpcExtensionUIRequest[] = [];
  first.onUiRequest((request) => requests.push(request));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.id).toBe("pending");
  expect((requests[0] as { timeout: number }).timeout).toBeLessThan(5000);
  const closed: string[] = [];
  first.onUiClose((id) => closed.push(id));
  engine.context.onUiClose("pending");
  await waitFor(() => closed.length > 0);
  expect(closed).toEqual(["pending"]);
  await first.close();
  const second = await client(worker);
  second.onUiRequest((request) => requests.push(request));
  expect(requests).toHaveLength(1);
});

test("connection deadlines bound a peer that never completes the handshake", async () => {
  const root = directory();
  const path = join(root, "silent.sock");
  const server = createServer();
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await expect(connectWorker(path, { timeout: 20 })).rejects.toThrow("handshake timed out");
});

test("socket handshake rejects another protocol before it can acquire control", async () => {
  const { worker } = await fakeWorker();
  const socket = connect(worker.socketPath);
  cleanup.push(() => {
    socket.destroy();
  });
  const reply = await new Promise<string>((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString()));
    socket.once("connect", () => socket.write('{"type":"hello","version":999,"control":true}\n'));
  });
  expect(reply).toContain("handshake required");
  expect((await client(worker)).identity.version).toBe(1);
});

test("a rejected peer cannot smuggle a valid handshake and mutation in the same packet", async () => {
  const { worker, engine } = await fakeWorker();
  const socket = connect(worker.socketPath);
  cleanup.push(() => {
    socket.destroy();
  });
  const reply = await new Promise<string>((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString()));
    socket.once("connect", () =>
      socket.write(
        `${[
          { type: "hello", version: 999, control: true },
          { type: "hello", version: 1, control: true },
          { type: "command", id: "smuggled", command: { type: "prompt", message: "must not execute" } },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
      ),
    );
  });
  expect(reply).toContain("rejected");
  await client(worker);
  expect(engine.prompts).toBe(0);
});

test("private endpoint and state ownership prevent a second writer", async () => {
  const { worker, root, options } = await fakeWorker();
  expect(statSync(worker.socketPath).mode & 0o777).toBe(0o600);
  expect(statSync(root).mode & 0o777).toBe(0o700);
  await expect(startWorker(options)).rejects.toThrow("already owned");
  expect((await client(worker)).identity.sessionId).toBe("fake-session");
});

test("existing command receipts cannot be rebound to another native transcript", async () => {
  const { worker, options, root } = await fakeWorker();
  await worker.close();
  await expect(startWorker({ ...options, sessionFile: join(root, "another-session.jsonl") })).rejects.toThrow(
    "cannot be rebound",
  );
});

test("shutdown closes peers that have not completed the handshake", async () => {
  const { worker } = await fakeWorker();
  const socket = connect(worker.socketPath);
  cleanup.push(() => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  await worker.close();
}, 1000);

test("worker help succeeds without launching a session", () => {
  const help = spawnSync(process.execPath, [join(import.meta.dir, "worker.ts"), "--help"], {
    encoding: "utf8",
  });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Disconnecting detaches");
  expect(help.stderr).toBe("");
});

test("terminal-facing events and snapshots use the shared escape sanitizer", async () => {
  const { worker, engine } = await fakeWorker();
  const connected = await client(worker);
  const events: import("@pituitary/rpc").PiEvent[] = [];
  connected.onEvent((event) => events.push(event));
  engine.context.onEvent({
    type: "extension_error",
    extensionPath: "fixture",
    event: "test",
    error: "\u001b[2Junsafe\u001b]0;title\u0007",
  });
  await waitFor(() => events.length > 0);
  expect(events[0]).toMatchObject({ error: "unsafe" });
});

test("real Pi creates durable history without a model and resumes its exact native session", async () => {
  const root = directory();
  const extensionDirectory = join(root, "configuration", "extensions");
  mkdirSync(extensionDirectory, { recursive: true });
  writeFileSync(
    join(extensionDirectory, "must-not-load.ts"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "ambient-extension-loaded"))}, 'unsafe'); export default function () {}`,
  );
  // Distinct auth and configuration paths ensure this test never reads operator Pi state.
  const options = {
    socketPath: join(root, "native.sock"),
    stateDirectory: root,
    cwd: root,
    configDirectory: join(root, "configuration"),
    authFile: join(root, "credentials", "auth.json"),
  };
  let worker = await startWorker(options);
  cleanup.push(() => worker.close());
  const first = await client(worker);
  const original = await first.getState();
  expect(existsSync(join(root, "ambient-extension-loaded"))).toBe(false);
  expect(original.sessionFile?.startsWith(root)).toBe(true);
  await first.request({ type: "set_session_name", name: "Durable before a model reply" }, "name-session");
  const shellUpdates: string[] = [];
  first.onEvent((event) => {
    if (event.type === "bash_execution_update" && event.id) shellUpdates.push(event.id);
  });
  await first.bash("operator-shell", "printf 'saved without a model'", false);
  expect(shellUpdates.length).toBeGreaterThan(0);
  expect(new Set(shellUpdates)).toEqual(new Set(["operator-shell"]));
  expect(
    (await first.getMessages()).some((message) => (message as { role?: string }).role === "bashExecution"),
  ).toBe(true);
  await expect(first.call({ type: "new_session" })).rejects.toThrow("managed runs keep one conversation");
  expect(readFileSync(original.sessionFile as string, "utf8")).toContain("saved without a model");
  await first.close();
  await worker.close();
  worker = await startWorker(options);
  const second = await client(worker);
  const resumed = await second.getState();
  if (!second.getSnapshot) throw new Error("native worker did not advertise atomic snapshots");
  const snapshot = await second.getSnapshot();
  expect(snapshot.state.sessionId).toBe(original.sessionId);
  expect(snapshot.messages).toEqual(await second.getMessages());
  expect(snapshot.pendingToolCalls).toEqual([]);
  expect(snapshot.queue).toEqual({ steering: [], followUp: [] });
  expect(snapshot.sequence).toBeGreaterThanOrEqual(0);
  expect(resumed.sessionId).toBe(original.sessionId);
  expect(resumed.sessionName).toBe("Durable before a model reply");
  expect(await second.getMessages()).toHaveLength(1);
  expect((await second.getSessionStats()).userMessages).toBe(0);
}, 15_000);

test("restoring a replaced native transcript refuses the old command ledger", async () => {
  const root = directory();
  const options = {
    socketPath: join(root, "native.sock"),
    stateDirectory: root,
    cwd: root,
    configDirectory: join(root, "configuration"),
    authFile: join(root, "credentials", "auth.json"),
  };
  const worker = await startWorker(options);
  const original = worker.identity;
  await worker.close();
  const path = original.sessionFile as string;
  const replaced = readFileSync(path, "utf8").replace(
    original.sessionId,
    "00000000-0000-4000-8000-000000000000",
  );
  writeFileSync(path, replaced);
  await expect(startWorker(options)).rejects.toThrow("identity changed");
  expect(readFileSync(path, "utf8")).toBe(replaced);
  expect(JSON.parse(readFileSync(join(root, "worker.json"), "utf8")).sessionId).toBe(original.sessionId);
});
