import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("durable local runs", () => {
  test("an existing run store migrates without losing native history or stop intent", () => {
    const root = directory();
    const old = new Database(join(root, "runs.sqlite"));
    old.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL,
      directory TEXT NOT NULL, socket TEXT NOT NULL, status TEXT NOT NULL,
      created TEXT NOT NULL, session_id TEXT, pid INTEGER, prompt TEXT,
      prompt_status TEXT, error TEXT
    ); PRAGMA user_version=1;`);
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
      expect(store.get("old")).toMatchObject({
        sessionId: "native-conversation",
        status: "stopped",
        desired: "stopped",
        execution: { kind: "local" },
        promptStatus: "accepted",
      });
      const created = store.create({ name: "new", cwd: root });
      expect(created.desired).toBe("running");
      expect(store.list()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("run identity and transitions survive a new runtime connection", () => {
    const root = directory();
    let store = new RunStore(root);
    const run = store.create({ cwd: root, name: "review", prompt: "Review this exact tree" });
    store.update(run.id, { status: "ready", sessionId: "pi-conversation", pid: 42 }, "worker_ready");
    store.close();
    store = new RunStore(root);
    try {
      expect(store.get("review")).toEqual({ ...run, status: "ready", sessionId: "pi-conversation", pid: 42 });
      expect(store.events(run.id).map((event) => event.type)).toEqual(["run_created", "worker_ready"]);
      const first = store.events(run.id)[0];
      expect(store.events(run.id, first?.sequence)).toHaveLength(1);
      expect(store.list()).toHaveLength(1);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "runs.sqlite")).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  test("a duplicate name does not leave a second run or a journal entry", () => {
    const root = directory();
    const store = new RunStore(root);
    try {
      store.create({ cwd: root, name: "builder" });
      expect(() => store.create({ cwd: root, name: "builder" })).toThrow("already exists");
      expect(store.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("socket paths stay short for deep state directories and separate namespaces", () => {
    const root = directory();
    const one = new RunStore(join(root, "x".repeat(150)));
    const two = new RunStore(join(root, "y".repeat(150)));
    try {
      const a = one.create({ cwd: root });
      const b = two.create({ cwd: root });
      expect(a.socket.length).toBeLessThan(104);
      expect(b.socket).not.toBe(a.socket);
    } finally {
      one.close();
      two.close();
    }
  });
});
