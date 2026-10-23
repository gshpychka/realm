import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentCatalog } from "./catalog.ts";
import type { RunDetail } from "./model.ts";
import { Orchestrator } from "./orchestrator.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const wait = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  const until = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= until)
      throw new Error("Native domain did not reach its expected state: " + JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
function declaration(name: string, delegatesTo: string[] = []) {
  return {
    manifest: {
      schemaVersion: 1 as const,
      name,
      description: name,
      instructions: "Frozen role " + name,
      model: "faux/faux-1",
      tools: [],
      delegatesTo,
      credentials: [],
      limits: { maxChildren: 2, maxDepth: 2 },
    },
    program: name,
    machine: "test",
    machineRevision: "a".repeat(64),
  };
}
async function fixture(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const directory = mkdtempSync(join(tmpdir(), "pituitary-domain-")),
    socket = join(directory, "bay.sock");
  const catalog: AgentCatalog = {
    schemaVersion: 1,
    baySocket: socket,
    agents: { coordinator: declaration("coordinator", ["reader"]), reader: declaration("reader") },
  };
  const sessions = new Map<
    string,
    {
      id: string;
      generation: number;
      name: string;
      state: string;
      program: string;
      machine: string;
      machineRevision: string;
    }
  >();
  let creates = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://bay").pathname.split("/");
      const name = decodeURIComponent(path[3] ?? "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (path[4] === "start") {
        const agent = catalog.agents[body.program];
        if (!agent) throw new Error("Undeclared fake machine");
        const session = {
          id: "record-" + ++creates,
          generation: 1,
          name,
          state: "running",
          program: agent.program,
          machine: agent.machine,
          machineRevision: agent.machineRevision,
        };
        sessions.set(name, session);
        response.end(JSON.stringify(session));
        return;
      }
      const session = sessions.get(name);
      if (!session) {
        response.writeHead(404);
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (path[4] === "suspend") {
        if (body.id !== session.id || body.generation !== session.generation) {
          response.writeHead(409);
          response.end(JSON.stringify({ error: "identity changed" }));
          return;
        }
        if (session.state !== "running") {
          response.writeHead(409);
          response.end(JSON.stringify({ error: "already suspended" }));
          return;
        }
        session.state = "suspended";
        response.end("{}");
        return;
      }
      response.end(JSON.stringify(session));
    })().catch((error) => {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const domain = await Orchestrator.open({ root: join(directory, "state"), catalog, models });
  cleanup.push(async () => {
    await domain.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    domain,
    directory,
    catalog,
    sessions,
    faux,
    get creates() {
      return creates;
    },
  };
}

test("native operator receipt freezes the reachable role graph once, even after catalog edits", async () => {
  const f = await fixture([
    fauxAssistantMessage(fauxToolCall("ask", { question: "Which target?" }), { stopReason: "toolUse" }),
  ]);
  const file = join(f.directory, "agents.json");
  const encode = () =>
    JSON.stringify({
      ...f.catalog,
      agents: Object.fromEntries(
        Object.entries(f.catalog.agents).map(([name, role]) => [
          name,
          {
            ...role.manifest,
            program: role.program,
            machine: role.machine,
            machineRevision: role.machineRevision,
          },
        ]),
      ),
    });
  writeFileSync(file, encode());
  const input = { name: "frozen", cwd: f.directory, agent: "coordinator", prompt: "Ask the operator" };
  const first = await f.domain.start(input, "start-once", file);
  f.catalog.agents.coordinator!.manifest.instructions = "New role for new runs";
  writeFileSync(file, encode());
  const replay = await f.domain.start(input, "start-once", file);
  expect(replay.id).toBe(first.id);
  expect(replay.catalog?.agents.coordinator?.manifest.instructions).toBe("Frozen role coordinator");
  expect((await f.domain.list()).length).toBe(1);
  await expect(
    f.domain.start({ ...input, prompt: "A different command" }, "start-once", file),
  ).rejects.toThrow("another payload");
});

test("native question, attributable answer, immutable report and archived conversation form one flow", async () => {
  const f = await fixture([
    fauxAssistantMessage(fauxToolCall("ask", { question: "Which target?", choices: ["module", "package"] }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("submit", { summary: "Use a module." }), { stopReason: "toolUse" }),
  ]);
  const run = await f.domain.start({
    name: "question",
    cwd: f.directory,
    agent: "reader",
    prompt: "Ask then report.",
  });
  const waiting = await wait(
    () => f.domain.inspect(run.id),
    (detail) => detail.questions.length === 1,
  );
  const question = waiting.questions[0]!;
  expect(question.status).toBe("open");
  const answered = await f.domain.answer(question.id, "module", "answer-once");
  expect(answered.status).toBe("answered");
  const replay = await f.domain.answer(question.id, "module", "answer-once");
  expect(replay.id).toBe(question.id);
  const done = await wait(
    () => f.domain.inspect(run.id),
    (detail) => detail.tasks[0]?.status === "submitted" && detail.attempts[0]?.status === "stopped",
  );
  expect(done.reports).toHaveLength(1);
  expect(done.tasks[0]?.reportId).toBe(done.reports[0]?.id);
  expect(done.run.acceptedArtifactId).toBeNull();
  const archived = await f.domain.conversation(run.id);
  expect(archived.canWrite).toBe(false);
  expect(archived.identity.archived).toBe(true);
  const context = await archived.conversation.context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(context.messages)).toContain("from operator");
  expect(JSON.stringify(context.messages)).toContain(question.id);
  expect([...f.sessions.values()].every((session) => session.state === "suspended")).toBe(true);
});

test("delegation uses bounded native ownership; revising a child withdraws its ancestor's report", async () => {
  const f = await fixture(
    Array.from({ length: 20 }, () => async (transcript) => {
      const last = transcript.messages.at(-1),
        text = JSON.stringify(transcript.messages);
      if (text.includes("Child objective"))
        return fauxAssistantMessage(fauxToolCall("submit", { summary: "Child facts." }), {
          stopReason: "toolUse",
        });
      if (last?.role === "toolResult" && last.toolName === "delegate")
        return fauxAssistantMessage(fauxToolCall("yield", { reason: "Waiting for the reader" }), {
          stopReason: "toolUse",
        });
      if (last?.role === "user" && JSON.stringify(last.content).includes("submitted unverified report"))
        return fauxAssistantMessage(
          fauxToolCall("submit", { summary: "Coordinator conclusion based on child facts." }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        fauxToolCall("delegate", { agent: "reader", objective: "Child objective" }),
        { stopReason: "toolUse" },
      );
    }),
  );
  const run = await f.domain.start({
    name: "team",
    cwd: f.directory,
    agent: "coordinator",
    prompt: "Coordinate one reader.",
  });
  const done = await wait(
    () => f.domain.inspect(run.id),
    (detail) =>
      detail.tasks.length === 2 &&
      detail.tasks.every((task) => task.status === "submitted") &&
      detail.attempts.every((attempt) => attempt.status === "stopped"),
  );
  const parent = done.tasks.find((task) => !task.parentTaskId)!,
    child = done.tasks.find((task) => task.parentTaskId)!;
  expect(done.reports).toHaveLength(2);
  const reportId = parent.reportId;
  await f.domain.revise(child.id, child.revision, { objective: "Child objective revised" }, "revise-child");
  const revised = await f.domain.inspect(run.id),
    withdrawn = revised.tasks.find((task) => task.id === parent.id)!;
  expect(withdrawn.reportId).toBeNull();
  expect(withdrawn.status).toBe("superseded");
  expect(revised.reports.some((report) => report.id === reportId)).toBe(true);
  expect(revised.tasks.find((task) => task.id === child.id)?.revision).toBe(2);
  expect(revised.run.acceptedArtifactId).toBeNull();
});

test("stopping a completed report retains its immutable result and read-only native conversation", async () => {
  const f = await fixture([
    fauxAssistantMessage(fauxToolCall("submit", { summary: "Retain this report." }), {
      stopReason: "toolUse",
    }),
  ]);
  const run = await f.domain.start({ name: "retain", cwd: f.directory, agent: "reader", prompt: "Report." });
  const done = await wait(
    () => f.domain.inspect(run.id),
    (detail) => detail.tasks[0]?.status === "submitted" && detail.attempts[0]?.status === "stopped",
  );
  await f.domain.stop(run.id, "stop-once");
  const stopped = await f.domain.inspect(run.id);
  expect(stopped.tasks[0]?.reportId).toBe(done.tasks[0]?.reportId);
  expect(stopped.reports).toEqual(done.reports);
  expect((await f.domain.conversation(run.id)).canWrite).toBe(false);
});

test("a submission admitted after stop intent cannot start a provider request or compaction", async () => {
  const f = await fixture([]);
  const run = await f.domain.start({ name: "fenced", cwd: f.directory, model: "faux/faux-1" });
  const attached = await f.domain.waitConversation(run.id),
    attemptId = Number(attached.identity.attemptId);
  const nativeAbort = f.domain.harness.abortTask.bind(f.domain.harness);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    atAbort = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.domain.harness.abortTask = async (id, context) => {
    if (id === attemptId) {
      entered();
      await held;
    }
    return nativeAbort(id, context);
  };
  const stopping = f.domain.stop(run.id, "stop-before-admission");
  try {
    await atAbort;
    const input = await attached.conversation.submit(
      {
        type: "input",
        content: "This stale input must not spend a model request.",
        requestId: "stale-human-input",
      },
      BACKGROUND_CONTEXT,
    );
    const settled = await input.wait(BACKGROUND_CONTEXT);
    expect(settled.status).toBe("unanswered");
    const compaction = await attached.conversation.compact(
      "Do not summarize stale input.",
      BACKGROUND_CONTEXT,
    );
    await f.domain.harness.waitForTask(compaction, BACKGROUND_CONTEXT);
    expect(f.faux.state.callCount).toBe(0);
  } finally {
    release();
    await stopping;
    f.domain.harness.abortTask = nativeAbort;
  }
});

test("a fresh parent attempt receives its own child grant while all task history remains bounded", async () => {
  const f = await fixture(
    Array.from({ length: 30 }, () => async (transcript) => {
      const last = transcript.messages.at(-1),
        first = transcript.messages.find((message) => message.role === "user");
      if (JSON.stringify(first).includes("Child objective"))
        return fauxAssistantMessage(fauxToolCall("submit", { summary: "Child facts." }), {
          stopReason: "toolUse",
        });
      if (last?.role === "toolResult" && last.toolName === "delegate")
        return fauxAssistantMessage(fauxToolCall("yield", { reason: "Waiting for the reader" }), {
          stopReason: "toolUse",
        });
      if (last?.role === "user" && JSON.stringify(last.content).includes("submitted unverified report"))
        return fauxAssistantMessage(fauxToolCall("submit", { summary: "Coordinator conclusion." }), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(
        fauxToolCall("delegate", { agent: "reader", objective: "Child objective" }),
        { stopReason: "toolUse" },
      );
    }),
  );
  f.catalog.agents.coordinator!.manifest.limits.maxChildren = 1;
  const run = await f.domain.start({
    name: "fresh-grant",
    cwd: f.directory,
    agent: "coordinator",
    prompt: "Coordinate one reader.",
  });
  const first = await wait(
    () => f.domain.inspect(run.id),
    (detail) =>
      detail.tasks.length === 2 &&
      detail.tasks.every((task) => task.status === "submitted") &&
      detail.attempts.every((attempt) => attempt.status === "stopped"),
  );
  await f.domain.retry(first.run.rootTaskId, 1);
  const second = await wait(
    () => f.domain.inspect(run.id),
    (detail) =>
      detail.tasks.length === 3 &&
      detail.tasks
        .filter((task) => task.status !== "superseded")
        .every((task) => task.status === "submitted"),
  );
  expect(second.tasks.filter((task) => task.parentTaskId === first.run.rootTaskId)).toHaveLength(2);
  expect(second.tasks.filter((task) => task.status === "superseded")).toHaveLength(1);
  expect(second.reports).toHaveLength(4);
});
