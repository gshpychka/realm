import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCatalog, AgentDefinition } from "./catalog.ts";
import type { WorkerAssignment } from "./domain-protocol.ts";
import { Engine } from "./engine.ts";
import { type Attempt, type Effect, RunStore } from "./store.ts";

const stores: RunStore[] = [],
  directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function definition(name: string, delegatesTo: string[] = []): AgentDefinition {
  return {
    program: `pituitary-${name}`,
    machine: "shared",
    machineRevision: "a".repeat(64),
    manifest: {
      schemaVersion: 1,
      name,
      description: name,
      instructions: `Original ${name}`,
      model: null,
      tools: ["read"],
      delegatesTo,
      credentials: [],
      limits: { maxChildren: 2, maxDepth: 2 },
    },
  };
}
function fixture(limits = {}) {
  const root = mkdtempSync(join(tmpdir(), "pituitary-engine-"));
  directories.push(root);
  const store = new RunStore(root);
  stores.push(store);
  const catalog: AgentCatalog = {
    schemaVersion: 1,
    baySocket: "/run/bay/bay.sock",
    agents: {
      coordinator: definition("coordinator", ["reviewer"]),
      reviewer: definition("reviewer"),
      unrelated: definition("unrelated"),
    },
  };
  let now = 1_000;
  const engine = new Engine(store, { catalog, limits, now: () => now });
  const run = engine.start(
    {
      name: "review",
      cwd: root,
      agent: "coordinator",
      prompt: "Review exact inputs",
      repos: ["owner/repo@main"],
    },
    "start",
  );
  const assignment = (attempt: Attempt): WorkerAssignment => ({
    runId: run.id,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    epoch: attempt.epoch,
  });
  return {
    root,
    store,
    catalog,
    engine,
    run,
    assignment,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function claim(engine: Engine, kind: Effect["kind"]): Effect {
  const effect = engine.claimEffect();
  expect(effect?.kind).toBe(kind);
  if (!effect) throw new Error(`No ${kind} effect`);
  return effect;
}
function activate(engine: Engine, store: RunStore, expectedTask?: string): Attempt {
  const effect = claim(engine, "launch"),
    attempt = store.getAttempt(effect.attemptId);
  if (expectedTask) expect(attempt.taskId).toBe(expectedTask);
  if (attempt.execution.kind !== "bay") throw new Error("Expected Bay execution");
  engine.ackEffect(effect.id, {
    execution: { ...attempt.execution, recordId: `record-${attempt.id}`, generation: 1 },
    sessionId: `native-${attempt.id}`,
    incarnation: `process-${attempt.id}`,
    resolvedRepos: ["owner/repo@" + "b".repeat(40)],
  });
  engine.ackEffect(claim(engine, "prompt").id);
  return store.getAttempt(attempt.id);
}

test("only newly assigned Bay attempts receive host orchestration authority", () => {
  const { engine, store, run, root, assignment } = fixture();
  const task = store.getTask(run.rootTaskId);
  const attempt = store.getAttempt(task.currentAttemptId);
  expect(attempt.grant.orchestration).toBe(true);
  const local = engine.start({ name: "local", cwd: root });
  expect(store.getAttempt(store.getTask(local.rootTaskId).currentAttemptId).grant.orchestration).toBe(false);
  store.putAttempt({ ...attempt, grant: { ...attempt.grant, orchestration: false } });
  expect(() => engine.command(assignment(attempt), "legacy-inspect", { type: "inspect" })).toThrow(
    "no orchestration authority",
  );
  expect(() =>
    engine.command(assignment(attempt), "legacy-submit", { type: "submit", summary: "Unauthorized report" }),
  ).toThrow("no orchestration authority");
  expect(store.listTasks(run.id)).toHaveLength(1);
  expect(store.getTask(task.id).report).toBeNull();
});

test("coordinator delegates, yields, exchanges a question/reply, and receives an immutable report", () => {
  const { store, engine, run, assignment } = fixture();
  const parent = activate(engine, store),
    actor = assignment(parent);
  const delegated = engine.command(actor, "delegate", {
    type: "delegate",
    agent: "reviewer",
    objective: "Review the exact tree",
  }) as { taskId: string };
  engine.command(actor, "wait", { type: "yield", reason: "Waiting for review" });
  const child = activate(engine, store, delegated.taskId),
    childActor = assignment(child);
  expect(child.execution.kind === "bay" && child.execution.repos).toEqual(["owner/repo@" + "b".repeat(40)]);
  const sent = engine.command(childActor, "question", {
    type: "message",
    to: "parent",
    body: "Should I inspect generated files?",
  }) as { messageId: string };
  const send = claim(engine, "send");
  expect(send.payload.toTaskId).toBe(parent.taskId);
  engine.ackEffect(send.id);
  engine.deliver(
    parent.id,
    [
      {
        id: sent.messageId,
        from: "reviewer",
        taskId: child.taskId,
        body: "Should I inspect generated files?",
      },
    ],
    "question-delivery",
  );
  engine.ackEffect(claim(engine, "deliver").id);
  expect(store.getTask(parent.taskId).status).toBe("running");
  engine.command(actor, "answer", {
    type: "message",
    to: child.taskId,
    replyTo: sent.messageId,
    body: "Inspect source files only.",
  });
  engine.ackEffect(claim(engine, "send").id);
  engine.deliver(
    child.id,
    [{ id: "answer", from: "coordinator", body: "Inspect source files only.", replyTo: sent.messageId }],
    "answer-delivery",
  );
  engine.ackEffect(claim(engine, "deliver").id);
  const result = engine.command(childActor, "report", {
    type: "submit",
    summary: "Found one unchecked failure.",
  }) as { reportId: string };
  const notice = claim(engine, "deliver");
  expect(JSON.stringify(notice.payload)).toContain("unverified report");
  expect(JSON.stringify(notice.payload)).toContain("reviewer");
  engine.ackEffect(notice.id);
  expect(store.getTask(child.taskId).report).toMatchObject({
    id: result.reportId,
    text: "Found one unchecked failure.",
    attemptId: child.id,
  });
  expect(store.detail(run.id).tasks).toHaveLength(2);
  engine.command(actor, "final", { type: "submit", summary: "Review ready for the operator." });
  expect(store.getTask(parent.taskId).status).toBe("submitted");
  expect(() => engine.command(childActor, "late", { type: "submit", summary: "Replace the report" })).toThrow(
    "no longer accepts",
  );
});

test("command receipts deduplicate delegation and reject ID reuse with another payload", () => {
  const { store, engine, assignment } = fixture();
  const actor = assignment(activate(engine, store));
  const command = { type: "delegate" as const, agent: "reviewer", objective: "One review" };
  const first = engine.command(actor, "once", command);
  expect(engine.command(actor, "once", command)).toEqual(first);
  expect(store.listTasks(actor.runId)).toHaveLength(2);
  expect(
    store.listEffects(actor.runId).filter((effect) => effect.kind === "launch" && effect.state === "pending"),
  ).toHaveLength(1);
  expect(() => engine.command(actor, "once", { ...command, objective: "Different review" })).toThrow(
    "another payload",
  );
});

test("frozen reachable definitions and resolved inputs govern children", () => {
  const { store, catalog, engine, run, assignment } = fixture();
  const actor = assignment(activate(engine, store));
  catalog.agents.reviewer!.manifest.instructions = "Changed after run creation";
  expect(Object.keys(store.getRun(run.id).catalog!.agents).sort()).toEqual(["coordinator", "reviewer"]);
  const result = engine.command(actor, "child", {
    type: "delegate",
    agent: "reviewer",
    objective: "Review",
  }) as { attemptId: string };
  const child = store.getAttempt(result.attemptId);
  expect(child.execution.kind === "bay" && child.execution.agent.manifest.instructions).toBe(
    "Original reviewer",
  );
});

test("task and role limits are enforced before creating work", () => {
  const { store, engine, assignment } = fixture({ maxTasks: 2 });
  const actor = assignment(activate(engine, store));
  engine.command(actor, "first", { type: "delegate", agent: "reviewer", objective: "First" });
  expect(() =>
    engine.command(actor, "excess", { type: "delegate", agent: "reviewer", objective: "Second" }),
  ).toThrow("task limit");
  expect(store.listTasks(actor.runId)).toHaveLength(2);
});

test("cancellation fences stale authority and cleans up a late launch acknowledgement", () => {
  const { store, engine, run, assignment } = fixture();
  const launching = claim(engine, "launch"),
    attempt = store.getAttempt(launching.attemptId);
  engine.stop(run.id, "stop");
  engine.ackEffect(claim(engine, "stop").id);
  if (attempt.execution.kind !== "bay") throw new Error("Expected Bay execution");
  engine.ackEffect(launching.id, {
    execution: { ...attempt.execution, recordId: "late-record", generation: 1 },
    sessionId: "late-native",
    incarnation: "late-process",
  });
  const cleanup = claim(engine, "stop");
  expect(store.getAttempt(cleanup.attemptId).execution).toMatchObject({ recordId: "late-record" });
  expect(() =>
    engine.command(assignment(attempt), "stale", { type: "submit", summary: "Late result" }),
  ).toThrow("Stale worker");
});

test("uncertain launches reconcile without issuing another launch", () => {
  const { store, engine } = fixture();
  const effect = claim(engine, "launch");
  engine.recoverEffects();
  expect(store.getEffect(effect.id)).toMatchObject({ kind: "reconnect", state: "pending" });
  expect(claim(engine, "reconnect").id).toBe(effect.id);
});

test("busy/capacity deferral preserves a healthy source attempt", () => {
  const { store, engine, assignment, advance } = fixture();
  const attempt = activate(engine, store);
  engine.command(assignment(attempt), "question", {
    type: "message",
    to: "operator",
    body: "Please confirm scope",
  });
  const effect = claim(engine, "send");
  engine.deferEffect(effect.id, "Recipient not ready", 100);
  expect(store.getAttempt(attempt.id).status).toBe("ready");
  expect(engine.claimEffect()).toBeNull();
  advance(100);
  expect(claim(engine, "send").id).toBe(effect.id);
});

test("execution generation changes revoke acceptance rather than rebinding an attempt", () => {
  const { store, engine, assignment } = fixture();
  const attempt = activate(engine, store);
  if (attempt.execution.kind !== "bay") throw new Error("Expected Bay execution");
  const result = engine.observeAttempt(attempt.id, { execution: { ...attempt.execution, generation: 2 } });
  expect(result).toMatchObject({ desired: "stopped", status: "interrupted", epoch: 2 });
  expect(() =>
    engine.command(assignment(attempt), "stale", { type: "submit", summary: "Rewound result" }),
  ).toThrow("Stale worker");
  expect(claim(engine, "stop").attemptId).toBe(attempt.id);
});

test("deadlines durably cancel all tasks before further dispatch", () => {
  const { engine, store, run, advance } = fixture({ deadlineMs: 100 });
  advance(100);
  expect(claim(engine, "stop").kind).toBe("stop");
  expect(store.getRun(run.id).desired).toBe("stopped");
  expect(store.listTasks(run.id)[0]?.status).toBe("cancelled");
});

test("capacity deferral retains proof that cancellation has no environment to stop", () => {
  const { store, engine, run } = fixture();
  const launch = claim(engine, "launch");
  const attempt = store.getAttempt(launch.attemptId);
  engine.deferEffect(launch.id, "Bay capacity is full");
  expect(store.getAttempt(attempt.id).status).toBe("queued");
  engine.stop(run.id);
  const stop = claim(engine, "stop");
  expect(stop.payload.unstarted).toBe(true);
  engine.ackEffect(stop.id);
  engine.recoverEffects();
  expect(engine.claimEffect()).toBeNull();
  if (attempt.execution.kind !== "bay") throw new Error("Expected Bay execution");
  engine.recordExecution(attempt.id, {
    ...attempt.execution,
    recordId: "unexpected-late-record",
    generation: 1,
  });
  const cleanup = claim(engine, "stop");
  expect(cleanup.payload.unstarted).not.toBe(true);
  expect(store.getAttempt(attempt.id).execution).toMatchObject({ recordId: "unexpected-late-record" });
});

test("a proven preallocation failure remains failed without impossible guest cleanup", () => {
  const { store, engine, run } = fixture();
  const launch = claim(engine, "launch");
  engine.failEffect(launch.id, "Credential profile is unavailable", { terminal: true });
  expect(store.getAttempt(launch.attemptId)).toMatchObject({
    status: "failed",
    desired: "stopped",
    error: "Credential profile is unavailable",
  });
  expect(store.getRun(run.id).desired).toBe("stopped");
  expect(store.getTask(run.rootTaskId).status).toBe("failed");
  expect(engine.claimEffect()).toBeNull();
});
