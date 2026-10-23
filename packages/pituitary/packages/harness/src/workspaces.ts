import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { assertBayJob, Bay, type BayCommand, type BayIdentity, type BayJob } from "./bay.ts";
import type { Artifact, BayExecution, ExecutionContext, Run } from "./model.ts";
import { privateDirectory } from "./paths.ts";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const oid = (value: string): string => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error("Invalid Git object identity");
  return value;
};
const key = (value: string): string => sha(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const pathName = (name: string): string => {
  if (
    !name ||
    isAbsolute(name) ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new Error(`Unsafe workspace path: ${name}`);
  return name;
};

export class GitError extends Error {
  constructor(
    readonly code: number,
    readonly output: Buffer,
    detail: string,
  ) {
    super(detail);
  }
}

/** Only Git plumbing runs on the host. Project commands run inside declared Bay machines. */
export function git(
  directory: string,
  args: readonly string[],
  input?: Buffer | string,
  env: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const child = spawn(
      process.env.PITUITARY_GIT ?? "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.fsync=all",
        "-c",
        "protocol.file.allow=always",
        "-C",
        directory,
        ...args,
      ],
      {
        env: {
          ...inherited,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0,
      errorBytes = 0;
    const terminate = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 120_000);
    timeout.unref();
    signal?.addEventListener("abort", terminate, { once: true });
    if (signal?.aborted) terminate();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) terminate();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= 64 * 1024) errors.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", terminate);
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", terminate);
      const output = Buffer.concat(chunks);
      if (signal?.aborted) reject(signal.reason);
      else if (timedOut || code !== 0 || bytes > 32 * 1024 * 1024)
        reject(
          new GitError(
            code ?? -1,
            output,
            timedOut
              ? "Git plumbing exceeded its two-minute time limit"
              : Buffer.concat(errors).toString("utf8").trim() || "Git plumbing failed",
          ),
        );
      else done(output);
    });
    child.stdin.end(input);
  });
}

async function atomic(path: string, value: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function saved<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Commit immutable content without replacing another writer's acknowledged file. */
async function publish(path: string, value: Buffer | string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return await readFile(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function bayIdentity(execution: BayExecution): BayIdentity {
  if (!execution.recordId || execution.generation === null)
    throw new Error("Workspace execution has no durable Bay identity");
  return {
    sessionName: execution.sessionName,
    recordId: execution.recordId,
    generation: execution.generation,
  };
}

/** A receipt is a command, not a retry hint. An uncertain job is never dispatched again. */
export async function waitJob(
  bay: Bay,
  identity: BayIdentity,
  id: string,
  command: BayCommand,
  alive: () => boolean | Promise<boolean> = () => true,
): Promise<BayJob> {
  let receipt = await bay.job(identity, id, command);
  const deadline = Date.now() + command.timeoutMs + 60_000;
  assertBayJob(receipt, identity, id, command);
  while (receipt.status === "running") {
    if (!(await alive())) throw new Error("Execution cancelled; its durable Bay job is retained");
    if (Date.now() > deadline) throw new Error("Bay job outcome remains unknown; inspect its saved receipt");
    await new Promise((done) => setTimeout(done, 100));
    receipt = await bay.job(identity, id);
    assertBayJob(receipt, identity, id, command);
  }
  return receipt;
}

const commitEnvironment = {
  GIT_AUTHOR_NAME: "Pituitary",
  GIT_AUTHOR_EMAIL: "pituitary@localhost",
  GIT_COMMITTER_NAME: "Pituitary",
  GIT_COMMITTER_EMAIL: "pituitary@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

/** Immutable code, from an untouched operator checkout to a retained, independently verified tree. */
export class Workspaces {
  private readonly applies = new Map<string, Promise<{ artifactId: string; applied: boolean }>>();
  constructor(
    readonly root: string,
    private readonly active: () => boolean = () => true,
  ) {
    privateDirectory(join(root, "artifacts"));
  }
  private repository(runId: string): string {
    return join(this.root, "workspaces", key(runId), "repository.git");
  }
  private receipt(runId: string, operation: string): string {
    return join(this.root, "workspaces", key(runId), `${key(operation)}.json`);
  }
  bundle(artifact: Artifact): string {
    return join(this.root, "artifacts", `${artifact.content}.bundle`);
  }

  private async repositoryReady(runId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const path = this.repository(runId);
    await mkdir(path, { recursive: true, mode: 0o700 });
    try {
      await lstat(join(path, "HEAD"));
    } catch (error) {
      if (!missing(error)) throw error;
      await git(path, ["init", "--bare", "--object-format=sha1"], undefined, {}, signal);
    }
    return path;
  }

  private async provenance(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ head: string | null; indexHash: string }> {
    let head: string | null = null;
    try {
      head = oid(
        (await git(cwd, ["rev-parse", "--verify", "HEAD"], undefined, {}, signal)).toString().trim(),
      );
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
    const index = (await git(cwd, ["rev-parse", "--git-path", "index"], undefined, {}, signal))
      .toString()
      .trim();
    let bytes = Buffer.alloc(0);
    try {
      bytes = await readFile(resolve(cwd, index), { signal });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return { head, indexHash: sha(bytes) };
  }

  private async tree(
    run: Run,
    extraPaths: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<{ tree: string; source: NonNullable<Artifact["source"]> }> {
    const cwd = await realpath(run.cwd);
    const root = await realpath(
      (await git(cwd, ["rev-parse", "--show-toplevel"], undefined, {}, signal)).toString().trim(),
    );
    if (cwd !== root) throw new Error("--workspace must select the repository root");
    const source = await this.provenance(cwd, signal),
      entries = new Map<string, string>();
    const stage = await git(cwd, ["ls-files", "--stage", "-z"], undefined, {}, signal);
    for (const entry of stage.toString("utf8").split("\0").filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
      if (match?.[3] !== "0") throw new Error("Resolve unmerged index entries before starting a workspace");
      if (match[1] === "160000")
        throw new Error("Writable workspaces require submodules to be separate repository inputs");
      entries.set(pathName(match[4] as string), match[1] as string);
    }
    const selected = run.workspace?.includeUntracked ?? [];
    if (selected.length) {
      for (const name of selected) pathName(name);
      const untracked = await git(
        cwd,
        ["ls-files", "--others", "--exclude-standard", "-z", "--", ...selected],
        undefined,
        {},
        signal,
      );
      for (const name of untracked.toString("utf8").split("\0").filter(Boolean))
        entries.set(pathName(name), "100644");
    }
    for (const name of extraPaths) entries.set(pathName(name), "100644");
    const repo = await this.repositoryReady(run.id, signal),
      index = join(dirname(repo), `${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: index };
    let total = 0;
    try {
      await git(repo, ["read-tree", "--empty"], undefined, env, signal);
      const records: Buffer[] = [],
        objects: Buffer[] = [];
      for (const name of [...entries.keys()].sort()) {
        signal?.throwIfAborted();
        const path = join(cwd, name);
        let before: Awaited<ReturnType<typeof lstat>>;
        try {
          before = await lstat(path);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        const parent = await realpath(dirname(path));
        if (parent !== cwd && !parent.startsWith(cwd + sep))
          throw new Error(`Workspace path leaves its repository: ${name}`);
        let bytes: Buffer, mode: string;
        if (before.isSymbolicLink()) {
          bytes = Buffer.from(await readlink(path));
          mode = "120000";
        } else if (before.isFile()) {
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await file.stat();
            if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
              throw new Error(`Workspace changed before capture: ${name}`);
            if (opened.size > run.limits.artifactBytes - total)
              throw new Error("Workspace file exceeds artifact limit");
            const chunks: Buffer[] = [];
            let size = 0;
            for (;;) {
              signal?.throwIfAborted();
              const chunk = Buffer.alloc(Math.min(64 * 1024, run.limits.artifactBytes - total - size + 1));
              const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
              if (!bytesRead) break;
              size += bytesRead;
              if (size > run.limits.artifactBytes - total)
                throw new Error("Workspace exceeds its artifact byte limit");
              chunks.push(chunk.subarray(0, bytesRead));
            }
            const afterRead = await file.stat();
            if (
              opened.size !== afterRead.size ||
              opened.mtimeMs !== afterRead.mtimeMs ||
              opened.ctimeMs !== afterRead.ctimeMs
            )
              throw new Error(`Workspace changed during capture: ${name}`);
            bytes = Buffer.concat(chunks);
          } finally {
            await file.close();
          }
          mode = before.mode & 0o111 ? "100755" : "100644";
        } else throw new Error(`Unsupported workspace entry: ${name}`);
        const after = await lstat(path);
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error(`Workspace changed during capture: ${name}`);
        total += bytes.length;
        if (total > run.limits.artifactBytes) throw new Error("Workspace exceeds its artifact byte limit");
        const object = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        objects.push(Buffer.from(`blob\ndata ${bytes.length}\n`), bytes, Buffer.from("\n"));
        records.push(Buffer.from(`${mode} ${object}\t${name}\0`));
      }
      // One plumbing process for every blob; filters and repository configuration never run.
      await git(repo, ["fast-import", "--quiet"], Buffer.concat(objects), {}, signal);
      await git(repo, ["update-index", "-z", "--index-info"], Buffer.concat(records), env, signal);
      const tree = oid((await git(repo, ["write-tree"], undefined, env, signal)).toString().trim());
      if (JSON.stringify(source) !== JSON.stringify(await this.provenance(cwd, signal)))
        throw new Error("Repository HEAD or index changed during capture");
      return { tree, source };
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  private async retain(
    run: Run,
    operation: string,
    manifest: Omit<Artifact, "id" | "content" | "bytes" | "created">,
    bytes: Buffer,
  ): Promise<Artifact> {
    if (!this.active()) throw new Error("Runtime detached before artifact publication");
    if (bytes.length > run.limits.artifactBytes)
      throw new Error("Git bundle exceeds its artifact byte limit");
    const content = sha(bytes),
      identity = { ...manifest, content, bytes: bytes.length };
    const artifact: Artifact = {
      ...identity,
      id: sha(JSON.stringify(identity)),
      created: new Date().toISOString(),
    };
    const retainedBytes = await publish(this.bundle(artifact), bytes);
    if (sha(retainedBytes) !== content) throw new Error("Content-addressed artifact bytes changed");
    if (!this.active()) throw new Error("Runtime detached before artifact receipt publication");
    const retained = JSON.parse(
      (await publish(this.receipt(run.id, operation), JSON.stringify(artifact))).toString(),
    ) as Artifact;
    if (retained.id !== artifact.id)
      throw new Error("Workspace operation already retained a different artifact; inspect its saved receipt");
    return retained;
  }

  private async commit(
    run: Run,
    tree: string,
    parents: readonly string[],
    operation: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return oid(
      (
        await git(
          this.repository(run.id),
          ["commit-tree", oid(tree), ...parents.flatMap((parent) => ["-p", oid(parent)])],
          `Pituitary ${operation}\n`,
          commitEnvironment,
          signal,
        )
      )
        .toString()
        .trim(),
    );
  }
  private async pack(run: Run, head: string, operation: string, signal?: AbortSignal): Promise<Buffer> {
    const repo = this.repository(run.id),
      ref = `refs/pituitary/${key(operation)}/${oid(head)}`;
    await git(repo, ["update-ref", ref, oid(head)], undefined, {}, signal);
    const path = join(dirname(repo), `${key(operation)}.${randomUUID()}.bundle`);
    try {
      await git(repo, ["bundle", "create", path, ref], undefined, {}, signal);
      return await readFile(path, { signal });
    } finally {
      await rm(path, { force: true });
    }
  }

  async capture(run: Run, signal?: AbortSignal): Promise<Artifact> {
    signal?.throwIfAborted();
    const previous = await saved<Artifact>(this.receipt(run.id, "input"));
    if (previous) return previous;
    const { tree, source } = await this.tree(run, [], signal),
      head = await this.commit(run, tree, [], `input ${run.id}`, signal);
    return this.retain(
      run,
      "input",
      {
        runId: run.id,
        taskId: null,
        attemptId: null,
        kind: "input",
        repository: "workspace",
        base: null,
        head,
        tree,
        source,
      },
      await this.pack(run, head, "input", signal),
    );
  }

  async materialize(
    run: Run,
    execution: BayExecution,
    artifact: Artifact,
    operation: string,
    alive?: () => boolean | Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (artifact.runId !== run.id) throw new Error("Workspace input belongs to another run");
    const bay = new Bay(execution.socket, signal),
      identity = bayIdentity(execution);
    const bytes = await readFile(this.bundle(artifact), { signal });
    if (sha(bytes) !== artifact.content) throw new Error("Retained input bundle changed");
    const blob = await bay.upload(identity, bytes);
    const script = `set -eu
test ! -e workspace
mkdir workspace
git -c core.hooksPath=/dev/null init -q workspace
git -C workspace -c core.hooksPath=/dev/null fetch -q --no-tags "$1" "$2"
git -C workspace -c core.hooksPath=/dev/null checkout -q --detach "$2"
test "$(git -C workspace rev-parse HEAD^{tree})" = "$3"
`;
    const receipt = await waitJob(
      bay,
      identity,
      key(operation),
      {
        argv: ["/bin/sh", "-c", script, "pituitary-input", blob.path, artifact.head, artifact.tree],
        cwd: ".",
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
        machineRevision: execution.agent.machineRevision,
        inputDigest: artifact.content,
      },
      alive,
    );
    if (receipt.status !== "succeeded" || receipt.exitCode !== 0)
      throw new Error(
        `Workspace materialization failed: ${receipt.error ?? receipt.stderr ?? receipt.status}`,
      );
  }

  async export(
    context: ExecutionContext,
    input: Artifact,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    signal?.throwIfAborted();
    const previous = await saved<Artifact>(this.receipt(context.run.id, operation));
    if (previous) return previous;
    const execution = context.attempt.execution;
    if (!execution) throw new Error("Code artifacts require an isolated Bay execution");
    const bay = new Bay(execution.socket, signal),
      identity = bayIdentity(execution);
    const ref = `refs/pituitary/results/${key(operation)}`,
      path = `.pituitary/${key(operation)}.bundle`;
    const script = `set -eu
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1
export GIT_AUTHOR_NAME=Pituitary GIT_AUTHOR_EMAIL=pituitary@localhost GIT_COMMITTER_NAME=Pituitary GIT_COMMITTER_EMAIL=pituitary@localhost
export GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z
test -d .git && test ! -L .git
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A -- .
tree=$(git write-tree)
head=$(printf '%s\\n' "$2" | git -c core.hooksPath=/dev/null commit-tree "$tree" -p "$1")
git update-ref "$3" "$head"
mkdir -p /work/.pituitary
git bundle create /work/"$4" "$3"
`;
    const receipt = await waitJob(bay, identity, key(operation), {
      argv: ["/bin/sh", "-c", script, "pituitary-export", input.head, operation, ref, path],
      cwd: "workspace",
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
      machineRevision: execution.agent.machineRevision,
      inputDigest: input.content,
    });
    if (receipt.status !== "succeeded" || receipt.exitCode !== 0)
      throw new Error(`Workspace export failed: ${receipt.error ?? receipt.stderr ?? receipt.status}`);
    const bytes = await bay.capture(identity, key(operation), path, context.run.limits.artifactBytes);
    return this.receive(context, input, bytes, operation, signal);
  }

  async receive(
    context: ExecutionContext,
    input: Artifact,
    bytes: Buffer,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    signal?.throwIfAborted();
    if (input.runId !== context.run.id) throw new Error("Result input belongs to another run");
    const previous = await saved<Artifact>(this.receipt(context.run.id, operation));
    if (previous) return previous;
    if (bytes.length > context.run.limits.artifactBytes)
      throw new Error("Export bundle exceeds its artifact byte limit");
    const { head, tree } = await this.import(
      context.run,
      bytes,
      `refs/pituitary/results/${key(operation)}`,
      input.head,
      operation,
      signal,
    );
    return this.retain(
      context.run,
      operation,
      {
        runId: context.run.id,
        taskId: context.task.id,
        attemptId: context.attempt.id,
        kind: "result",
        repository: "workspace",
        base: input.head,
        head,
        tree,
      },
      bytes,
    );
  }

  private async import(
    run: Run,
    bytes: Buffer,
    ref: string,
    base: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<{ head: string; tree: string }> {
    const repo = await this.repositoryReady(run.id, signal),
      path = join(dirname(repo), `${key(operation)}.${randomUUID()}.incoming.bundle`);
    await atomic(path, bytes);
    try {
      await git(repo, ["bundle", "verify", path], undefined, {}, signal);
      const heads = (await git(repo, ["bundle", "list-heads", path], undefined, {}, signal))
        .toString()
        .trim()
        .split("\n");
      if (heads.length !== 1 || !heads[0]?.endsWith(` ${ref}`))
        throw new Error("Export bundle contains unexpected references");
      const head = oid((heads[0] as string).split(" ")[0] as string);
      await git(
        repo,
        [
          "-c",
          "fetch.fsckObjects=true",
          "fetch",
          "--no-tags",
          path,
          `${ref}:refs/pituitary/imports/${key(operation)}`,
        ],
        undefined,
        {},
        signal,
      );
      await git(repo, ["merge-base", "--is-ancestor", oid(base), head], undefined, {}, signal);
      const tree = oid(
        (await git(repo, ["rev-parse", `${head}^{tree}`], undefined, {}, signal)).toString().trim(),
      );
      const entries = (await git(repo, ["ls-tree", "-r", "-z", "--full-tree", tree], undefined, {}, signal))
        .toString()
        .split("\0")
        .filter(Boolean);
      const objects: string[] = [];
      for (const entry of entries) {
        const match = /^(100644|100755|120000) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Export contains an unsupported Git tree entry");
        pathName(match[3] as string);
        objects.push(oid(match[2] as string));
      }
      const sizes = (
        await git(repo, ["cat-file", "--batch-check=%(objectsize)"], `${objects.join("\n")}\n`, {}, signal)
      )
        .toString()
        .trim()
        .split("\n");
      if (objects.length && sizes.length !== objects.length)
        throw new Error("Incomplete export object inventory");
      let total = 0;
      for (const size of objects.length ? sizes : []) {
        total += Number(size);
        if (!Number.isSafeInteger(total) || total > run.limits.artifactBytes)
          throw new Error("Export tree exceeds its artifact byte limit");
      }
      return { head, tree };
    } finally {
      await rm(path, { force: true });
    }
  }

  async integrate(
    run: Run,
    base: Artifact,
    result: Artifact,
    operation: string,
    signal?: AbortSignal,
  ): Promise<{ artifact?: Artifact; conflicts?: string[] }> {
    signal?.throwIfAborted();
    if (base.runId !== run.id || result.runId !== run.id)
      throw new Error("Integration artifacts belong to another run");
    const previous = await saved<Artifact>(this.receipt(run.id, operation));
    if (previous) return { artifact: previous };
    const repo = await this.repositoryReady(run.id, signal);
    let tree: string;
    try {
      tree = oid(
        (
          await git(
            repo,
            ["merge-tree", "--write-tree", "--name-only", "-z", oid(base.head), oid(result.head)],
            undefined,
            {},
            signal,
          )
        )
          .toString()
          .split("\0")[0] as string,
      );
    } catch (error) {
      if (!(error instanceof GitError) || error.code !== 1) throw error;
      const parts = error.output.toString().split("\0");
      const conflicts: string[] = [];
      for (const part of parts.slice(1)) {
        if (!part) break;
        conflicts.push(pathName(part));
      }
      if (!conflicts.length)
        throw new Error("Git integration failed without a retained conflict description");
      return { conflicts };
    }
    const head = await this.commit(
      run,
      tree,
      base.head === result.head ? [base.head] : [base.head, result.head],
      operation,
      signal,
    );
    return {
      artifact: await this.retain(
        run,
        operation,
        {
          runId: run.id,
          taskId: result.taskId,
          attemptId: result.attemptId,
          kind: "integration",
          repository: "workspace",
          base: base.head,
          head,
          tree,
        },
        await this.pack(run, head, operation, signal),
      ),
    };
  }

  /** Explicit operator action. Preserve the operator's HEAD and index, including staged edits. */
  apply(run: Run, input: Artifact, accepted: Artifact): Promise<{ artifactId: string; applied: boolean }> {
    const previous = this.applies.get(run.id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.applyResult(run, input, accepted));
    this.applies.set(run.id, operation);
    void operation
      .finally(() => {
        if (this.applies.get(run.id) === operation) this.applies.delete(run.id);
      })
      .catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.applies.values()]);
  }

  private async applyResult(
    run: Run,
    input: Artifact,
    accepted: Artifact,
  ): Promise<{ artifactId: string; applied: boolean }> {
    if (!this.active()) throw new Error("Runtime detached before applying code");
    if (input.runId !== run.id || accepted.runId !== run.id)
      throw new Error("Apply artifacts belong to another run");
    if (run.acceptedArtifactId !== accepted.id || run.integrationArtifactId !== accepted.id || !input.source)
      throw new Error("Run has no current verified result to apply");
    const operation = `apply:${accepted.id}`,
      receipt = this.receipt(run.id, operation);
    const previous = await saved<{ artifactId: string; applied: boolean }>(receipt);
    if (previous?.applied) return previous;
    if (JSON.stringify(await this.provenance(run.cwd)) !== JSON.stringify(input.source))
      throw new Error(
        "Operator HEAD or index changed since the run input; apply into a clean matching checkout",
      );
    const paths = (await git(this.repository(run.id), ["ls-tree", "-r", "--name-only", "-z", accepted.tree]))
      .toString()
      .split("\0")
      .filter(Boolean);
    const current = await this.tree(run, paths);
    if (previous && current.tree === accepted.tree) {
      const result = { artifactId: accepted.id, applied: true };
      await atomic(receipt, JSON.stringify(result));
      return result;
    }
    if (current.tree !== input.tree)
      throw new Error("Operator workspace changed since capture; retained artifacts remain available");
    if (accepted.tree === input.tree) {
      const result = { artifactId: accepted.id, applied: true };
      await atomic(receipt, JSON.stringify(result));
      return result;
    }
    const patch = await git(this.repository(run.id), [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      input.head,
      accepted.head,
    ]);
    await git(run.cwd, ["apply", "--check", "--binary", "-"], patch);
    if (!this.active()) throw new Error("Runtime detached before apply intent");
    await atomic(receipt, JSON.stringify({ artifactId: accepted.id, applied: false }));
    if (!this.active()) throw new Error("Runtime detached before applying code");
    await git(run.cwd, ["apply", "--binary", "-"], patch);
    if (
      (await this.tree(run, paths)).tree !== accepted.tree ||
      JSON.stringify(await this.provenance(run.cwd)) !== JSON.stringify(input.source)
    )
      throw new Error("Apply outcome requires inspection; no automatic second apply will occur");
    const result = { artifactId: accepted.id, applied: true };
    await atomic(receipt, JSON.stringify(result));
    return result;
  }
}
