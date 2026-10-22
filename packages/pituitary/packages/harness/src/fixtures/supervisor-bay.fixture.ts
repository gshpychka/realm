import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSnapshot,
  fakeSessionState,
  type RpcCommand,
  type RpcSessionState,
  stored,
} from "@pituitary/rpc";
import type { BayMessage, BaySession } from "../bay.ts";
import { parseCatalog } from "../catalog.ts";
import type { DomainCommand, InboxDelivery, InboxMessage } from "../domain-protocol.ts";
import { canonical, type WorkerEngine, type WorkerEngineContext } from "../protocol.ts";
import { startWorker, type Worker } from "../worker.ts";

export const QUESTION = "Should the read-only report focus on the public API?";
export const REPLY = "Yes. Review the public API and report without changing files.";
export const CHILD_REPORT =
  "Read-only finding: the public API keeps session identity separate from its execution generation.";
export const INPUT_COMMIT = "a".repeat(40);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export interface ScriptTurn {
  kind: "initial" | "question" | "reply" | "report";
  messages: InboxMessage[];
}

/** The model is scripted; real worker leases, durable domain requests, transport and host effects remain in use. */
export class ScriptedAgent implements WorkerEngine {
  readonly turns: ScriptTurn[] = [];
  readonly deliveries: InboxDelivery[] = [];
  readonly requests: Array<{ entry: string; tool: string; command: DomainCommand }> = [];
  readonly errors: Error[] = [];
  prompts = 0;
  closed = false;
  childTaskId?: string;
  context!: WorkerEngineContext;
  private readonly state: RpcSessionState = { ...fakeSessionState, sessionId: randomUUID() };
  private readonly entries = new Map<string, { entryId: string; payloadHash: string }>();
  private readonly history: unknown[] = [];
  private turnSequence = 0;

  constructor(
    readonly role: "coordinator" | "reader",
    private readonly beforeReply: () => Promise<void>,
  ) {}

  async initialize(context: WorkerEngineContext): Promise<WorkerEngine> {
    if (!context.assignment || !context.domain)
      throw new Error("Fixture worker requires a host assignment and domain channel");
    if (context.role?.name !== this.role) throw new Error("Fixture program received another agent role");
    this.context = context;
    this.state.sessionId = context.sessionId ?? this.state.sessionId;
    return this;
  }

  async call(command: RpcCommand): Promise<unknown> {
    if (command.type === "get_state") return { ...this.state, messageCount: this.history.length };
    if (command.type === "get_messages") return { messages: structuredClone(this.history) };
    if (command.type === "set_session_name") {
      this.state.sessionName = command.name;
      return;
    }
    if (command.type === "prompt") {
      this.prompts++;
      this.history.push(stored.user(command.message));
      this.begin("initial", []);
      return;
    }
    if (command.type === "abort") {
      this.state.isStreaming = false;
      this.context.onEvent({ type: "agent_settled" });
      return;
    }
    throw new Error(`Unsupported scripted worker command ${command.type}`);
  }

  async deliver(delivery: InboxDelivery): Promise<{ entryId: string; duplicate: boolean }> {
    const existing = this.entries.get(delivery.batchId);
    const payloadHash = createHash("sha256").update(canonical(delivery)).digest("hex");
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("Inbox batch changed payload");
      return { entryId: existing.entryId, duplicate: true };
    }
    if (this.state.isStreaming) throw new Error("worker is busy");
    const entryId = `inbox-${this.entries.size + 1}`;
    this.entries.set(delivery.batchId, { entryId, payloadHash });
    this.deliveries.push(structuredClone(delivery));
    this.history.push(
      stored.custom({
        customType: "pituitary.delivery",
        text: delivery.messages.map((message) => message.body).join("\n\n"),
        details: { batchId: delivery.batchId, payloadHash },
      }),
    );
    if (delivery.wake) {
      const body = delivery.messages.map((message) => message.body).join("\n");
      const kind = body.includes(QUESTION) ? "question" : body.includes(REPLY) ? "reply" : "report";
      this.begin(kind, delivery.messages);
    }
    return { entryId, duplicate: false };
  }

  deliveryStatus(batchId: string): { entryId: string | null; payloadHash?: string } {
    return this.entries.get(batchId) ?? { entryId: null };
  }
  snapshot(): Omit<AgentSnapshot, "sequence"> {
    return {
      state: { ...this.state, messageCount: this.history.length },
      messages: structuredClone(this.history),
      pendingToolCalls: [],
      queue: { steering: [], followUp: [] },
    };
  }
  respond(): void {}
  async close(): Promise<void> {
    this.closed = true;
  }

  private begin(kind: ScriptTurn["kind"], messages: InboxMessage[]): void {
    if (this.state.isStreaming)
      throw new Error("Scripted model was woken while its previous turn was active");
    this.state.isStreaming = true;
    this.turns.push({ kind, messages: structuredClone(messages) });
    const entry = `${this.role}-turn-${++this.turnSequence}`;
    this.context.onEvent({ type: "agent_start" });
    void Promise.resolve()
      .then(() => this.perform(entry, kind, messages))
      .catch((error) => {
        if (!this.closed) this.errors.push(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.state.isStreaming = false;
        if (!this.closed) this.context.onEvent({ type: "agent_settled" });
      });
  }

  private domain(entry: string, tool: string, command: DomainCommand): Promise<unknown> {
    // Each sequential tool gets its own assistant entry; yield never shares a parallel tool batch.
    const assistantEntry = `${entry}-${tool}`;
    this.requests.push({ entry: assistantEntry, tool, command });
    const domain = this.context.domain;
    if (!domain) throw new Error("Missing domain channel");
    return domain(assistantEntry, tool, command);
  }

  private async perform(entry: string, kind: ScriptTurn["kind"], messages: InboxMessage[]): Promise<void> {
    if (kind === "initial" && this.role === "coordinator") {
      const child = (await this.domain(entry, "delegate", {
        type: "delegate",
        agent: "reader",
        objective:
          "Read the public API and submit a report. Ask the coordinator about scope before reviewing.",
        acceptance: ["Make no workspace changes", "Name a concrete API property"],
      })) as { taskId: string };
      if (!child.taskId) throw new Error("Delegation did not return a task ID");
      this.childTaskId = child.taskId;
      await this.domain(entry, "yield", {
        type: "yield",
        reason: "Waiting for the reader's question or report",
      });
    } else if (kind === "initial") {
      await this.domain(entry, "question", { type: "message", to: "parent", body: QUESTION });
      await this.domain(entry, "yield", { type: "yield", reason: "Waiting for the coordinator's answer" });
    } else if (kind === "question" && this.role === "coordinator") {
      await this.beforeReply();
      if (!this.childTaskId) throw new Error("Question arrived before delegation finished");
      const question = messages.find((message) => message.body.includes(QUESTION));
      if (!question) throw new Error("Missing reader question");
      await this.domain(entry, "reply", {
        type: "message",
        to: this.childTaskId,
        body: REPLY,
        replyTo: question.id,
      });
      await this.domain(entry, "yield", { type: "yield", reason: "Waiting for the reader's report" });
    } else if (kind === "reply" && this.role === "reader") {
      await this.domain(entry, "submit", { type: "submit", summary: CHILD_REPORT });
      this.history.push(stored.assistant({ text: CHILD_REPORT }));
    } else if (kind === "report" && this.role === "coordinator") {
      if (!this.childTaskId) throw new Error("Report arrived without a child task");
      const inspection = (await this.domain(entry, "inspect", {
        type: "inspect",
        taskId: this.childTaskId,
      })) as { task: { report?: { text: string } } };
      if (inspection.task.report?.text !== CHILD_REPORT)
        throw new Error("The child's durable report was not available for inspection");
      await this.domain(entry, "submit", {
        type: "submit",
        summary: `Coordinator report: ${inspection.task.report.text}`,
      });
      this.history.push(stored.assistant({ text: `Coordinator report: ${inspection.task.report.text}` }));
    } else throw new Error(`Unexpected ${kind} wake for ${this.role}`);
  }
}

interface Guest {
  session: BaySession;
  worker: Worker;
  engine: ScriptedAgent;
  workspace: string;
}
interface StartInput {
  program: string;
  machineRevision: string;
  repos: string[];
}
interface RelayInput {
  id: string;
  generation: number;
  to: string;
  toId: string;
  clientId: string;
  thread?: number;
  body: string;
}

export async function supervisorBayFixture(
  options: {
    pauseBeforeReply?: boolean;
    loseFirstRelayReply?: boolean;
    refuseFirstReaderStart?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-supervisor-"));
  const stateDirectory = join(root, "runtime");
  const socket = join(root, "bay.sock");
  const bayCommand = join(root, "bay-fixture");
  const connector = fileURLToPath(new URL("./bay-connect.fixture.ts", import.meta.url));
  writeFileSync(bayCommand, `#!${process.execPath}\nimport ${JSON.stringify(connector)};\n`, { mode: 0o700 });
  const catalog = parseCatalog({
    schemaVersion: 1,
    baySocket: socket,
    agents: Object.fromEntries(
      ["coordinator", "reader"].map((name) => [
        name,
        {
          schemaVersion: 1,
          name,
          description: `Provider-free ${name}`,
          instructions: "Use the managed orchestration tools and retain all results.",
          model: null,
          tools: ["read", "grep"],
          delegatesTo: name === "coordinator" ? ["reader"] : [],
          credentials: [],
          program: `pituitary-${name}`,
          machine: "pituitary-shared-reader",
          machineRevision: "machine-revision-1",
        },
      ]),
    ),
  });
  const guests = new Map<string, Guest>();
  const starts: Array<{ name: string; input: StartInput }> = [];
  const suspends: Array<{ name: string; id: string; generation: number }> = [];
  const ended: string[] = [];
  const messages: BayMessage[] = [];
  const receipts = new Map<string, { input: string; message: BayMessage }>();
  const connections = new Set<Socket>();
  const reply = gate(),
    replyReached = gate();
  const errors: Error[] = [];
  const databaseId = randomUUID();
  let relayAttempts = 0,
    feedRequests = 0,
    lostReply = false,
    readerStartRequests = 0;

  const server = createServer(async (request, response) => {
    const fail = (status: number, error: string, code?: string) => {
      response
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error, ...(code ? { code } : {}) }));
    };
    try {
      const url = new URL(request.url ?? "/", "http://bay");
      if (request.method === "GET" && url.pathname === "/v1/messages/feed") {
        feedRequests++;
        const cursor = url.searchParams.get("after");
        const parts = cursor ? Buffer.from(cursor, "base64url").toString().split(":") : [databaseId, "0"];
        if (parts[0] !== databaseId) {
          fail(409, "mail cursor belongs to another database");
          return;
        }
        const after = Number(parts[1]);
        if (!Number.isSafeInteger(after) || after < 0) {
          fail(400, "bad cursor");
          return;
        }
        // One message per page makes the integration exercise forward cursor advancement.
        const pending = messages.filter((message) => message.id > after);
        const page = pending.slice(0, 1);
        const last = page.at(-1)?.id ?? after;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            messages: page,
            next: Buffer.from(`${databaseId}:${last}`).toString("base64url"),
            more: pending.length > page.length,
          }),
        );
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(\/start|\/suspend|\/end|\/messages|\/connect)?$/.exec(
        url.pathname,
      );
      if (!match) {
        fail(404, "unknown fixture path");
        return;
      }
      const name = decodeURIComponent(match[1] as string),
        action = match[2];
      const existing = guests.get(name);
      if (action === "/connect") {
        if (
          !existing ||
          existing.session.state !== "running" ||
          request.headers["bay-session-id"] !== existing.session.id ||
          request.headers["bay-session-generation"] !== String(existing.session.generation)
        ) {
          fail(409, "record or execution generation changed");
          return;
        }
        const guest = connect(existing.worker.socketPath);
        guest.on("error", () => response.destroy());
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Bay-Session-ID": existing.session.id,
          "Bay-Session-Generation": String(existing.session.generation),
        });
        response.flushHeaders();
        request.pipe(guest);
        guest.pipe(response);
        request.once("aborted", () => guest.destroy());
        response.once("close", () => guest.destroy());
        return;
      }
      const body = await jsonBody(request);
      if (action === "/start") {
        if (existing) {
          fail(409, "session already exists");
          return;
        }
        const input = body as StartInput;
        const definition = Object.values(catalog.agents).find((agent) => agent.program === input.program);
        if (!definition || definition.machineRevision !== input.machineRevision) {
          fail(409, "machine revision changed");
          return;
        }
        const role = definition.manifest.name;
        if (role !== "coordinator" && role !== "reader") throw new Error(`Unexpected role ${role}`);
        if (role === "reader") {
          readerStartRequests++;
          if (options.refuseFirstReaderStart && readerStartRequests === 1) {
            fail(409, "Fixture host has no machine capacity", "capacity_exhausted");
            return;
          }
        }
        const guestRoot = join(root, `guest-${starts.length}`),
          workspace = join(guestRoot, "work");
        mkdirSync(guestRoot, { mode: 0o700 });
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "retained.txt"), `Workspace for ${name}`);
        const engine = new ScriptedAgent(role, async () => {
          replyReached.release();
          if (options.pauseBeforeReply) await reply.promise;
        });
        const worker = await startWorker({
          socketPath: join(guestRoot, "worker.sock"),
          stateDirectory: join(guestRoot, "state"),
          cwd: workspace,
          roleRequired: true,
          engineFactory: (context) => engine.initialize(context),
        });
        const session: BaySession = {
          id: randomUUID(),
          generation: 1,
          name,
          state: "running",
          program: input.program,
          machine: definition.machine,
          machineRevision: definition.machineRevision,
          repos: input.repos.map(() => ({
            owner: "owner",
            name: "repo",
            commit: INPUT_COMMIT,
            branch: "main",
          })),
        };
        guests.set(name, { session, worker, engine, workspace });
        starts.push({ name, input: structuredClone(input) });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(session));
      } else if (!existing) fail(404, "no such session");
      else if (action === "/messages") {
        relayAttempts++;
        const input = body as RelayInput;
        if (input.id !== existing.session.id || input.generation !== existing.session.generation) {
          fail(409, "sender execution changed");
          return;
        }
        if (!input.clientId) {
          fail(400, "relay needs a stable clientId");
          return;
        }
        const key = `${input.id}:${input.clientId}`,
          encoded = canonical(input);
        const receipt = receipts.get(key);
        if (receipt) {
          if (receipt.input !== encoded) {
            fail(409, "clientId changed payload");
            return;
          }
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify(receipt.message));
          return;
        }
        const recipient = guests.get(input.to)?.session;
        if (!recipient || recipient.id !== input.toId) {
          fail(409, "recipient record changed");
          return;
        }
        const message: BayMessage = {
          id: messages.length + 1,
          thread: input.thread ?? messages.length + 1,
          from: name,
          fromId: existing.session.id,
          fromGeneration: existing.session.generation,
          to: recipient.name,
          toId: recipient.id,
          body: input.body,
          sent: new Date().toISOString(),
        };
        messages.push(message);
        receipts.set(key, { input: encoded, message });
        if (options.loseFirstRelayReply && !lostReply) {
          lostReply = true;
          response.destroy();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(message));
      } else if (action === "/suspend" || action === "/end") {
        const input = body as { id: string; generation: number };
        if (input.id !== existing.session.id || input.generation !== existing.session.generation) {
          fail(409, "lifecycle execution changed");
          return;
        }
        if (action === "/end") ended.push(name);
        else suspends.push({ name, ...input });
        existing.session.state = action === "/end" ? "ended" : "suspended";
        await existing.worker.close();
        response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      } else
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(existing.session));
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) fail(500, String(error));
      else response.destroy();
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    root,
    stateDirectory,
    catalog,
    bayCommand,
    guests,
    starts,
    suspends,
    ended,
    messages,
    errors,
    beforeReply: replyReached.promise,
    releaseReply: reply.release,
    get relayAttempts() {
      return relayAttempts;
    },
    get feedRequests() {
      return feedRequests;
    },
    get readerStartRequests() {
      return readerStartRequests;
    },
    agent(role: "coordinator" | "reader"): ScriptedAgent {
      const guest = [...guests.values()].find((guest) => guest.engine.role === role);
      if (!guest) throw new Error(`No ${role} guest was launched`);
      return guest.engine;
    },
    async close() {
      reply.release();
      await Promise.allSettled([...guests.values()].map((guest) => guest.worker.close()));
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Fixture request exceeds its byte limit");
    chunks.push(Buffer.from(chunk));
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
