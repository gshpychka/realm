import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "./engine.ts";
import { RunStore } from "./store.ts";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "pituitary-store-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("legacy runs migrate to one task/attempt without losing native history or stop intent", () => {
  const root = directory(),
    old = new Database(join(root, "runs.sqlite"));
  old.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,cwd TEXT NOT NULL,directory TEXT NOT NULL,socket TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,session_id TEXT,pid INTEGER,prompt TEXT,prompt_status TEXT,error TEXT); PRAGMA user_version=1;`,
  );
  old
    .query("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "old",
      "old",
      root,
      root,
      "/tmp/old.sock",
      "stopped",
      "2026-10-22",
      "native-conversation",
      42,
      "objective",
      "accepted",
      null,
    );
  old.close();
  const store = new RunStore(root);
  try {
    const run = store.getRun("old"),
      task = store.getTask(run.rootTaskId),
      attempt = store.getAttempt(task.currentAttemptId);
    expect(run).toMatchObject({ desired: "stopped", objective: "objective" });
    expect(run).not.toHaveProperty("execution");
    expect(task.status).toBe("cancelled");
    expect(attempt).toMatchObject({
      sessionId: "native-conversation",
      status: "stopped",
      desired: "stopped",
      execution: { kind: "local", socket: "/tmp/old.sock" },
      promptStatus: "accepted",
      grant: { orchestration: false, maxChildren: 0, maxDepth: 0 },
    });
    expect(attempt.socket).not.toBe("/tmp/old.sock");
    expect(store.listAttempts()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("run/task/attempt identities and receipts survive reopening", () => {
  const root = directory();
  let store = new RunStore(root);
  const run = new Engine(store).start({ cwd: root, name: "review", prompt: "Review" }, "stable-command");
  const before = store.detail(run.id);
  store.close();
  store = new RunStore(root);
  try {
    expect(store.detail(run.id)).toEqual(before);
    expect(
      new Engine(store).start({ cwd: root, name: "review", prompt: "Review" }, "stable-command"),
    ).toEqual(run);
    expect(store.listRuns()).toHaveLength(1);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "runs.sqlite")).mode & 0o777).toBe(0o600);
  } finally {
    store.close();
  }
});

test("a failed transaction leaves no partial run or effect", () => {
  const root = directory(),
    store = new RunStore(root),
    engine = new Engine(store);
  try {
    engine.start({ cwd: root, name: "review" });
    expect(() => engine.start({ cwd: root, name: "review" })).toThrow("already exists");
    expect(store.listRuns()).toHaveLength(1);
    expect(store.listEffects()).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("worker and proxy socket paths stay short and separate namespaces", () => {
  const root = directory(),
    one = new RunStore(join(root, "x".repeat(150))),
    two = new RunStore(join(root, "y".repeat(150)));
  try {
    const a = new Engine(one).start({ cwd: root }),
      b = new Engine(two).start({ cwd: root });
    const attemptA = one.detail(a.id).attempts[0]!,
      attemptB = two.detail(b.id).attempts[0]!;
    expect(attemptA.socket.length).toBeLessThan(104);
    expect(attemptA.execution.kind === "local" && attemptA.execution.socket.length).toBeLessThan(104);
    expect(attemptA.socket).not.toBe(attemptB.socket);
  } finally {
    one.close();
    two.close();
  }
});
