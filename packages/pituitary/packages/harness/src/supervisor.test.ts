import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import {
  CHILD_REPORT,
  INPUT_COMMIT,
  QUESTION,
  REPLY,
  supervisorBayFixture,
} from "./fixtures/supervisor-bay.fixture.ts";
import { Runtime, runtimeSocket } from "./runtime.ts";
import { type Run, type RunDetail, socketDirectory } from "./store.ts";
import { type SupervisorOptions, startRuntime } from "./supervisor.ts";

type Environment = Awaited<ReturnType<typeof supervisorBayFixture>>;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(options: Parameters<typeof supervisorBayFixture>[0] = {}) {
  const environment = await supervisorBayFixture(options);
  cleanup.push(async () => {
    await environment.close();
    rmSync(socketDirectory(environment.stateDirectory), { recursive: true, force: true });
  });
  return environment;
}

async function boot(environment: Environment, options: Pick<SupervisorOptions, "limits"> = {}) {
  const handle = await startRuntime({
    stateDirectory: environment.stateDirectory,
    catalog: environment.catalog,
    bayCommand: environment.bayCommand,
    ...options,
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  cleanup.push(close);
  return { close, client: new Runtime({ stateDirectory: environment.stateDirectory, autoStart: false }) };
}

function assertFixtureHealthy(environment: Environment): void {
  const errors = [
    ...environment.errors,
    ...[...environment.guests.values()].flatMap((guest) => guest.engine.errors),
  ];
  if (errors.length) throw new AggregateError(errors, "Scripted orchestration failed");
}

async function until(environment: Environment, predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    assertFixtureHealthy(environment);
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the durable orchestration flow");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function completed(environment: Environment, runtime: Runtime, runId: string): Promise<RunDetail> {
  let detail!: RunDetail;
  await until(environment, async () => {
    detail = await runtime.inspect(runId);
    return (
      detail.tasks.length === 2 &&
      detail.tasks.every((task) => task.status === "submitted") &&
      detail.attempts.every((attempt) => attempt.status === "stopped")
    );
  });
  return detail;
}

function assertCompletedFlow(environment: Environment, detail: RunDetail): void {
  expect(environment.starts).toHaveLength(2);
  expect(detail.tasks).toHaveLength(2);
  expect(detail.attempts).toHaveLength(2);
  const root = detail.tasks.find((task) => task.id === detail.run.rootTaskId);
  const child = detail.tasks.find((task) => task.parentTaskId === detail.run.rootTaskId);
  expect(root?.role).toBe("coordinator");
  expect(child?.role).toBe("reader");
  expect(child?.report?.text).toBe(CHILD_REPORT);
  expect(child?.report?.digest).toBe(createHash("sha256").update(CHILD_REPORT).digest("hex"));
  expect(root?.report?.text).toBe(`Coordinator report: ${CHILD_REPORT}`);
  expect(new Set(detail.attempts.map((attempt) => attempt.sessionId)).size).toBe(2);
  expect(detail.events.filter((event) => event.type === "task_delegated")).toHaveLength(1);
  expect(detail.events.filter((event) => event.type === "report_submitted")).toHaveLength(2);
  expect(environment.agent("coordinator").prompts).toBe(1);
  expect(environment.agent("reader").prompts).toBe(1);
  expect(environment.agent("coordinator").turns.map((turn) => turn.kind)).toEqual([
    "initial",
    "question",
    "report",
  ]);
  expect(environment.agent("reader").turns.map((turn) => turn.kind)).toEqual(["initial", "reply"]);
  expect(environment.messages).toHaveLength(2);
  expect(environment.messages[0]?.body).toContain(QUESTION);
  expect(environment.messages[1]?.body).toContain(REPLY);
  expect(environment.messages[1]?.thread).toBe(environment.messages[0]?.thread);
  for (const message of environment.messages) {
    const sender = environment.guests.get(message.from),
      recipient = environment.guests.get(message.to);
    if (!sender || !recipient) throw new Error("Mail named a participant outside this run");
    expect(message.from).not.toBe("operator");
    expect(message.fromId).toBe(sender.session.id);
    expect(message.toId).toBe(recipient.session.id);
    expect(message.fromGeneration).toBe(1);
  }
  expect(environment.feedRequests).toBeGreaterThan(0);
  expect(environment.ended).toEqual([]);
  expect(environment.suspends).toHaveLength(2);
  for (const guest of environment.guests.values()) {
    expect(guest.session.state).toBe("suspended");
    expect(readFileSync(join(guest.workspace, "retained.txt"), "utf8")).toContain(guest.session.name);
    const batches = guest.engine.deliveries.map((delivery) => delivery.batchId);
    expect(new Set(batches).size).toBe(batches.length);
  }
  assertFixtureHealthy(environment);
}

async function assertArchivedChild(runtime: Runtime, detail: RunDetail): Promise<void> {
  const child = detail.tasks.find((task) => task.parentTaskId === detail.run.rootTaskId);
  const attempt = detail.attempts.find((attempt) => attempt.taskId === child?.id);
  if (!child || !attempt) throw new Error("Missing completed child conversation");
  const archived = await runtime.connect(detail.run, false, child.id);
  try {
    expect(archived.identity).toMatchObject({ archived: true, sessionId: attempt.sessionId });
    expect((await archived.getState()).isStreaming).toBe(false);
    expect(JSON.stringify(await archived.getMessages())).toContain(CHILD_REPORT);
    if (!archived.getSnapshot) throw new Error("Archived conversation lacks its atomic viewport");
    expect(JSON.stringify((await archived.getSnapshot()).messages)).toContain(CHILD_REPORT);
    await expect(archived.prompt("This must never restart a completed child")).rejects.toThrow("archived");
  } finally {
    await archived.close();
  }
}

test("the coordinator delegates, answers a real Bay-mail question, and assembles a durable read-only report", async () => {
  const environment = await fixture({ pauseBeforeReply: true, loseFirstRelayReply: true });
  const { client } = await boot(environment);
  const run = await client.start({
    name: "read-api",
    cwd: environment.root,
    agent: "coordinator",
    prompt: "Read the API with a reader agent and submit a concise report.",
    repos: ["owner/repo@main"],
  });
  // Force the stored-but-unacknowledged mail through its retry path before permitting the answer.
  await until(
    environment,
    () =>
      environment.guests.size === 2 &&
      environment.agent("coordinator").turns.some((turn) => turn.kind === "question") &&
      environment.relayAttempts >= 2,
  );
  environment.releaseReply();
  const detail = await completed(environment, client, run.id);
  assertCompletedFlow(environment, detail);
  await assertArchivedChild(client, detail);
  expect(environment.relayAttempts).toBe(3);
  expect(environment.starts.map((start) => start.input.repos)).toEqual([
    ["owner/repo@main"],
    [`owner/repo@${INPUT_COMMIT}`],
  ]);
  await client.stop(run.id);
  expect(environment.ended).toEqual([]);
  expect(environment.starts).toHaveLength(2);
}, 30_000);

test("restarting the one host runtime preserves workers, receipts, mail delivery, and the active coordinator turn", async () => {
  const environment = await fixture({ pauseBeforeReply: true });
  const first = await boot(environment);
  const input = {
    id: "operator-start-once",
    name: "restart-flow",
    cwd: environment.root,
    agent: "coordinator",
    prompt: "Delegate a read-only API review and answer its question.",
    repos: ["owner/repo@main"],
  };
  const run = await runtimeRequest<Run>(environment.stateDirectory, "/v1/runs", input);
  await until(
    environment,
    () =>
      environment.guests.size === 2 &&
      environment.agent("coordinator").turns.some((turn) => turn.kind === "question"),
  );
  const before = await first.client.inspect(run.id);
  const child = before.tasks.find((task) => task.parentTaskId === run.rootTaskId);
  const childAttempt = before.attempts.find((attempt) => attempt.taskId === child?.id);
  const childSessionId = childAttempt?.sessionId;
  if (!child || !childAttempt || !childSessionId) throw new Error("Missing reader conversation");
  const observer = await first.client.connect(run, false, child.id);
  try {
    expect(observer.identity.sessionId).toBe(childSessionId);
    expect(observer.identity.assignment?.attemptId).toBe(childAttempt.id);
    expect((await observer.getState()).sessionId).toBe(childSessionId);
  } finally {
    await observer.close();
  }
  const identities = [...environment.guests.values()].map((guest) => ({
    recordId: guest.session.id,
    generation: guest.session.generation,
    nativeId: guest.worker.identity.sessionId,
    incarnation: guest.worker.identity.incarnation,
  }));
  await first.close();
  for (const guest of environment.guests.values()) {
    expect(guest.session.state).toBe("running");
    expect(guest.engine.closed).toBe(false);
  }
  const second = await boot(environment);
  const duplicate = await runtimeRequest<Run>(environment.stateDirectory, "/v1/runs", input);
  expect(duplicate.id).toBe(run.id);
  await until(environment, async () => {
    const current = await second.client.inspect(run.id);
    return (
      current.attempts.length === 2 &&
      current.attempts.every((attempt) => !["starting", "queued", "unreachable"].includes(attempt.status))
    );
  });
  const coordinator = environment.agent("coordinator");
  const delegate = coordinator.requests.find((request) => request.command.type === "delegate");
  const childTaskId = coordinator.childTaskId;
  if (!delegate || !coordinator.context.domain || !childTaskId)
    throw new Error("Missing durable delegation request");
  const replay = (await coordinator.context.domain(delegate.entry, delegate.tool, delegate.command)) as {
    taskId: string;
  };
  expect(replay.taskId).toBe(childTaskId);
  expect(environment.starts).toHaveLength(2);
  expect(
    [...environment.guests.values()].map((guest) => ({
      recordId: guest.session.id,
      generation: guest.session.generation,
      nativeId: guest.worker.identity.sessionId,
      incarnation: guest.worker.identity.incarnation,
    })),
  ).toEqual(identities);
  environment.releaseReply();
  const detail = await completed(environment, second.client, run.id);
  assertCompletedFlow(environment, detail);
  await assertArchivedChild(second.client, detail);
  expect(detail.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
  expect(detail.attempts.map((attempt) => attempt.id)).toEqual(before.attempts.map((attempt) => attempt.id));
  expect((await second.client.list()).map((item) => item.id)).toEqual([run.id]);
  expect(environment.relayAttempts).toBe(2);
}, 30_000);

test("a definite Bay admission refusal waits and retries launch without occupying its own run capacity", async () => {
  const environment = await fixture({ refuseFirstReaderStart: true });
  const { client } = await boot(environment, { limits: { maxLiveAttempts: 2 } });
  const run = await client.start({
    name: "capacity-flow",
    cwd: environment.root,
    agent: "coordinator",
    prompt: "Delegate a read-only review, answer its question, and report.",
    repos: ["owner/repo@main"],
  });
  await until(environment, async () => {
    if (environment.readerStartRequests !== 1) return false;
    const waiting = await client.inspect(run.id);
    const child = waiting.tasks.find((task) => task.parentTaskId === run.rootTaskId);
    return waiting.attempts.some((attempt) => attempt.taskId === child?.id && attempt.status === "queued");
  });
  const detail = await completed(environment, client, run.id);
  assertCompletedFlow(environment, detail);
  expect(environment.readerStartRequests).toBe(2);
  expect(environment.starts).toHaveLength(2);
  expect(detail.attempts.every((attempt) => attempt.number === 1)).toBe(true);
}, 30_000);

function runtimeRequest<T>(stateDirectory: string, path: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: runtimeSocket(stateDirectory),
        path,
        method: "POST",
        agent: false,
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if ((response.statusCode ?? 500) >= 300)
              reject(new Error(value.error ?? "Runtime request failed"));
            else resolve(value as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("Fixture runtime request timed out")));
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(body));
  });
}
