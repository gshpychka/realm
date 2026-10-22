import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentCatalog, AgentDefinition } from "./catalog.ts";

export interface RunLimits {
  maxTasks: number;
  maxLiveAttempts: number;
  maxDepth: number;
  deadlineMs: number;
  reportBytes: number;
}
export const DEFAULT_RUN_LIMITS: Readonly<RunLimits> = {
  maxTasks: 16,
  maxLiveAttempts: 4,
  maxDepth: 2,
  deadlineMs: 60 * 60 * 1000,
  reportBytes: 64 * 1024,
};
/** One authorized objective. Execution identity belongs to its attempts. */
export interface Run {
  id: string;
  name: string;
  cwd: string;
  objective: string;
  created: string;
  desired: "running" | "stopped";
  rootTaskId: string;
  catalog: AgentCatalog | null;
  limits: RunLimits;
  deadline: number;
  repos: readonly string[];
}
export type TaskStatus = "queued" | "running" | "waiting" | "submitted" | "failed" | "cancelled";
export interface Report {
  id: string;
  attemptId: string;
  digest: string;
  text: string;
  at: string;
}
export interface Task {
  id: string;
  runId: string;
  parentTaskId: string | null;
  role: string | null;
  objective: string;
  acceptance: readonly string[];
  status: TaskStatus;
  currentAttemptId: string;
  waitFor: readonly string[];
  report: Report | null;
}
export type AttemptStatus =
  | "queued"
  | "starting"
  | "ready"
  | "busy"
  | "waiting"
  | "stopping"
  | "stopped"
  | "unreachable"
  | "interrupted"
  | "failed";
export type RunStatus = AttemptStatus;
export type PromptStatus = "pending" | "dispatching" | "accepted" | "uncertain" | null;
export interface BayExecution {
  kind: "bay";
  socket: string;
  command: string;
  sessionName: string;
  recordId: string | null;
  generation: number | null;
  agent: AgentDefinition;
  repos: readonly string[];
}
export type RunExecution = { kind: "local"; socket: string } | BayExecution;
export interface Attempt {
  id: string;
  taskId: string;
  number: number;
  depth: number;
  directory: string;
  socket: string;
  status: AttemptStatus;
  desired: "running" | "stopped";
  sessionId: string | null;
  incarnation: string | null;
  epoch: number;
  pid: number | null;
  promptStatus: PromptStatus;
  error: string | null;
  execution: RunExecution;
  grant: { orchestration: boolean; maxChildren: number; maxDepth: number };
}
export interface RunEvent {
  sequence: number;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
export interface Effect {
  id: string;
  runId: string;
  attemptId: string;
  epoch: number;
  kind: "launch" | "reconnect" | "prompt" | "deliver" | "send" | "stop";
  payload: Record<string, unknown>;
  state: "pending" | "dispatching" | "done" | "uncertain" | "cancelled" | "failed";
  tries: number;
  notBefore: number;
  error: string | null;
}
export interface RunDetail {
  run: Run;
  tasks: Task[];
  attempts: Attempt[];
  events: RunEvent[];
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error(`Expected a directory owned by the current operator: ${path}`);
  chmodSync(path, 0o700);
}
export function socketDirectory(root: string): string {
  const namespace = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  const parent = `/tmp/pituitary-runs-${process.getuid?.() ?? "operator"}`;
  privateDirectory(parent);
  const directory = join(parent, namespace);
  privateDirectory(directory);
  return directory;
}

/** The host runtime is the only writer. Pi files remain transcript authority. */
export class RunStore {
  private readonly db: Database;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    privateDirectory(this.root);
    const path = join(this.root, "runs.sqlite");
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Run database must not be a symlink");
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if (this.version() > 4) {
      this.db.close();
      throw new Error("Run database requires a newer Pituitary");
    }
    this.transaction(() => {
      if (this.version() === 4) return;
      const legacy = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
      if (legacy) this.db.exec("ALTER TABLE runs RENAME TO legacy_runs;");
      this.db.exec(`
        CREATE TABLE runs (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX tasks_run ON tasks(run_id);
        CREATE TABLE attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX attempts_task ON attempts(task_id);
        CREATE TABLE commands (principal TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(principal,id));
        CREATE TABLE effects (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX effects_run ON effects(run_id);
        CREATE TABLE cursors (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence);
        ALTER TABLE events ADD COLUMN task_id TEXT;
        ALTER TABLE events ADD COLUMN attempt_id TEXT;
      `);
      if (legacy) {
        for (const row of this.db.query<Record<string, unknown>, []>("SELECT * FROM legacy_runs").all())
          this.migrate(row);
        this.db.exec("DROP TABLE legacy_runs;");
      }
      this.db.exec("PRAGMA user_version=4;");
    });
    this.db.exec("CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  }
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
  findRun(name: string): Run | null {
    const row = this.db
      .query<{ data: string }, [string, string]>("SELECT data FROM runs WHERE id=? OR name=?")
      .get(name, name);
    return row ? (JSON.parse(row.data) as Run) : null;
  }
  getRun(name: string): Run {
    const run = this.findRun(name);
    if (!run) throw new Error(`No run named ${name}`);
    return run;
  }
  listRuns(): Run[] {
    return this.all<Run>("runs");
  }
  putRun(run: Run): void {
    this.db
      .query("INSERT INTO runs(id,name,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(run.id, run.name, JSON.stringify(run));
  }
  getTask(id: string): Task {
    return this.entity<Task>("tasks", id);
  }
  listTasks(runId: string): Task[] {
    return this.all<Task>("tasks", "run_id", runId);
  }
  putTask(task: Task): void {
    this.db
      .query(
        "INSERT INTO tasks(id,run_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(task.id, task.runId, JSON.stringify(task));
  }
  getAttempt(id: string): Attempt {
    return this.entity<Attempt>("attempts", id);
  }
  listAttempts(taskId?: string): Attempt[] {
    return this.all<Attempt>("attempts", taskId ? "task_id" : undefined, taskId);
  }
  putAttempt(attempt: Attempt): void {
    this.db
      .query(
        "INSERT INTO attempts(id,task_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(attempt.id, attempt.taskId, JSON.stringify(attempt));
  }
  receipt(principal: string, id: string): { payload: string; result: unknown } | null {
    const row = this.db
      .query<{ payload: string; receipt: string }, [string, string]>(
        "SELECT payload,receipt FROM commands WHERE principal=? AND id=?",
      )
      .get(principal, id);
    return row ? { payload: row.payload, result: JSON.parse(row.receipt) as unknown } : null;
  }
  putReceipt(principal: string, id: string, payload: string, result: unknown): void {
    this.db
      .query("INSERT INTO commands(principal,id,payload,receipt) VALUES (?,?,?,?)")
      .run(principal, id, payload, JSON.stringify(result));
  }
  getEffect(id: string): Effect {
    return this.entity<Effect>("effects", id);
  }
  listEffects(runId?: string): Effect[] {
    return this.all<Effect>("effects", runId ? "run_id" : undefined, runId);
  }
  putEffect(effect: Effect): void {
    this.db
      .query(
        "INSERT INTO effects(id,run_id,attempt_id,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(effect.id, effect.runId, effect.attemptId, JSON.stringify(effect));
  }
  getCursor(key: string): string | null {
    return (
      this.db.query<{ value: string }, [string]>("SELECT value FROM cursors WHERE key=?").get(key)?.value ??
      null
    );
  }
  setCursor(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO cursors(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  append(
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
    taskId: string | null = null,
    attemptId: string | null = null,
  ): void {
    this.db
      .query("INSERT INTO events(run_id,type,at,data,task_id,attempt_id) VALUES (?,?,?,?,?,?)")
      .run(runId, type, new Date().toISOString(), JSON.stringify(data), taskId, attemptId);
  }
  events(runId: string, after = 0): RunEvent[] {
    return this.db
      .query<
        {
          sequence: number;
          run_id: string;
          task_id: string | null;
          attempt_id: string | null;
          type: string;
          at: string;
          data: string;
        },
        [string, number]
      >("SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence")
      .all(runId, after)
      .map((event) => ({
        sequence: event.sequence,
        runId: event.run_id,
        taskId: event.task_id,
        attemptId: event.attempt_id,
        type: event.type,
        at: event.at,
        data: JSON.parse(event.data) as Record<string, unknown>,
      }));
  }
  detail(name: string): RunDetail {
    const run = this.getRun(name);
    const tasks = this.listTasks(run.id);
    const ids = new Set(tasks.map((task) => task.id));
    return {
      run,
      tasks,
      attempts: this.listAttempts().filter((attempt) => ids.has(attempt.taskId)),
      events: this.events(run.id),
    };
  }
  close(): void {
    this.db.close();
  }
  private version(): number {
    return this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  }
  private entity<T>(table: "tasks" | "attempts" | "effects", id: string): T {
    const row = this.db.query<{ data: string }, [string]>(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error(`No ${table} record named ${id}`);
    return JSON.parse(row.data) as T;
  }
  private all<T>(
    table: "runs" | "tasks" | "attempts" | "effects",
    column?: "run_id" | "task_id",
    id?: string,
  ): T[] {
    const rows = column
      ? this.db
          .query<{ data: string }, [string]>(`SELECT data FROM ${table} WHERE ${column}=? ORDER BY rowid`)
          .all(id as string)
      : this.db.query<{ data: string }, []>(`SELECT data FROM ${table} ORDER BY rowid`).all();
    return rows.map((row) => JSON.parse(row.data) as T);
  }
  private migrate(row: Record<string, unknown>): void {
    const id = String(row.id),
      taskId = `task-${id}`,
      attemptId = `attempt-${id}`;
    const execution = JSON.parse((row.execution as string | undefined) ?? '{"kind":"local"}') as RunExecution;
    if (execution.kind === "bay") execution.generation ??= null;
    else execution.socket = String(row.socket);
    const desired = row.desired === "stopped" || row.status === "stopped" ? "stopped" : "running";
    const catalog: AgentCatalog | null =
      execution.kind === "bay"
        ? {
            schemaVersion: 1,
            baySocket: execution.socket,
            agents: { [execution.agent.manifest.name]: execution.agent },
          }
        : null;
    const run: Run = {
      id,
      name: String(row.name),
      cwd: String(row.cwd),
      objective: String(row.prompt ?? ""),
      created: String(row.created),
      desired,
      rootTaskId: taskId,
      catalog,
      limits: { ...DEFAULT_RUN_LIMITS },
      deadline: Date.now() + DEFAULT_RUN_LIMITS.deadlineMs,
      repos: execution.kind === "bay" ? execution.repos : [],
    };
    this.putRun(run);
    this.putTask({
      id: taskId,
      runId: id,
      parentTaskId: null,
      role: execution.kind === "bay" ? execution.agent.manifest.name : null,
      objective: run.objective,
      acceptance: [],
      status: desired === "stopped" ? "cancelled" : "running",
      currentAttemptId: attemptId,
      waitFor: [],
      report: null,
    });
    this.putAttempt({
      id: attemptId,
      taskId,
      number: 1,
      depth: 0,
      directory: String(row.directory),
      socket: join(socketDirectory(this.root), `${attemptId}.sock`),
      status: row.status as AttemptStatus,
      desired,
      sessionId: row.session_id as string | null,
      incarnation: null,
      epoch: 1,
      pid: row.pid as number | null,
      promptStatus: row.prompt_status as PromptStatus,
      error: row.error as string | null,
      execution,
      grant: { orchestration: false, maxChildren: 0, maxDepth: 0 },
    });
  }
}
