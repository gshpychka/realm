import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type RunStatus = "starting" | "ready" | "busy" | "stopped" | "unreachable" | "failed";
export type PromptStatus = "pending" | "dispatching" | "accepted" | "uncertain" | null;

/** A run describes work. The worker and its native conversation have separate lifetimes. */
export interface Run {
  id: string;
  name: string;
  cwd: string;
  directory: string;
  socket: string;
  status: RunStatus;
  created: string;
  sessionId: string | null;
  pid: number | null;
  prompt: string | null;
  promptStatus: PromptStatus;
  error: string | null;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

type RunChanges = Partial<Pick<Run, "status" | "sessionId" | "pid" | "promptStatus" | "error">>;

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Expected a directory owned by the current operator: ${path}`);
  }
  chmodSync(path, 0o700);
}

/** Keep Unix socket names short even with a deeply nested checkout or macOS TMPDIR. */
export function socketDirectory(root: string): string {
  const namespace = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  const directory = `/tmp/pituitary-runs-${process.getuid?.() ?? "operator"}/${namespace}`;
  privateDirectory(`/tmp/pituitary-runs-${process.getuid?.() ?? "operator"}`);
  privateDirectory(directory);
  return directory;
}

/** Durable run records and a causal journal; native Pi files remain transcript authority. */
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
    const version =
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version > 1) {
      this.db.close();
      throw new Error(`Run database version ${version} requires a newer Pituitary`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL,
        directory TEXT NOT NULL, socket TEXT NOT NULL, status TEXT NOT NULL,
        created TEXT NOT NULL, session_id TEXT, pid INTEGER, prompt TEXT,
        prompt_status TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
        type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, sequence);
      PRAGMA user_version=1;
    `);
  }

  create(input: { name?: string; cwd: string; prompt?: string }): Run {
    const id = randomUUID();
    const name = input.name ?? id.slice(0, 8);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
      throw new Error(
        "A run name must be 1–64 letters, numbers, dots, underscores, or dashes, starting with a letter or number",
      );
    }
    const cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
    const run: Run = {
      id,
      name,
      cwd,
      directory: join(this.root, "runs", id),
      socket: join(socketDirectory(this.root), `${id}.sock`),
      status: "starting",
      created: new Date().toISOString(),
      sessionId: null,
      pid: null,
      prompt: input.prompt ?? null,
      promptStatus: input.prompt ? "pending" : null,
      error: null,
    };
    this.db
      .transaction(() => {
        if (this.find(name))
          throw new Error(`Run ${name} already exists; attach to it or choose another name`);
        try {
          this.db
            .query("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(
              run.id,
              run.name,
              run.cwd,
              run.directory,
              run.socket,
              run.status,
              run.created,
              run.sessionId,
              run.pid,
              run.prompt,
              run.promptStatus,
              run.error,
            );
        } catch (error) {
          if (this.find(name))
            throw new Error(`Run ${name} already exists; attach to it or choose another name`);
          throw error;
        }
        this.append(run.id, "run_created", { cwd, name, prompt: run.prompt });
      })
      .immediate();
    return run;
  }

  find(name: string): Run | null {
    const row = this.db
      .query<Record<string, unknown>, [string, string]>("SELECT * FROM runs WHERE id = ? OR name = ?")
      .get(name, name);
    return row ? decode(row) : null;
  }

  get(name: string): Run {
    const run = this.find(name);
    if (!run) throw new Error(`No run named ${name}`);
    return run;
  }

  list(): Run[] {
    return this.db
      .query<Record<string, unknown>, []>("SELECT * FROM runs ORDER BY created, id")
      .all()
      .map(decode);
  }

  update(id: string, changes: RunChanges | ((current: Run) => RunChanges | null), type: string): Run {
    return this.db
      .transaction(() => {
        const current = this.get(id);
        const patch = typeof changes === "function" ? changes(current) : changes;
        if (patch === null) return current;
        const run = { ...current, ...patch };
        this.db
          .query("UPDATE runs SET status=?, session_id=?, pid=?, prompt_status=?, error=? WHERE id=?")
          .run(run.status, run.sessionId, run.pid, run.promptStatus, run.error, run.id);
        this.append(id, type, patch);
        return run;
      })
      .immediate();
  }

  events(id: string, after = 0): RunEvent[] {
    return this.db
      .query<{ sequence: number; run_id: string; type: string; at: string; data: string }, [string, number]>(
        "SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence",
      )
      .all(id, after)
      .map((event) => ({
        sequence: event.sequence,
        runId: event.run_id,
        type: event.type,
        at: event.at,
        data: JSON.parse(event.data) as Record<string, unknown>,
      }));
  }

  close(): void {
    this.db.close();
  }

  private append(id: string, type: string, data: Record<string, unknown>): void {
    this.db
      .query("INSERT INTO events (run_id, type, at, data) VALUES (?, ?, ?, ?)")
      .run(id, type, new Date().toISOString(), JSON.stringify(data));
  }
}

function decode(row: Record<string, unknown>): Run {
  return {
    id: String(row.id),
    name: String(row.name),
    cwd: String(row.cwd),
    directory: String(row.directory),
    socket: String(row.socket),
    status: row.status as RunStatus,
    created: String(row.created),
    sessionId: row.session_id as string | null,
    pid: row.pid as number | null,
    prompt: row.prompt as string | null,
    promptStatus: row.prompt_status as PromptStatus,
    error: row.error as string | null,
  };
}
