import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Artifact, DEFAULT_RUN_LIMITS, type ExecutionContext, type Run } from "./model.ts";
import { git, Workspaces } from "./workspaces.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pituitary-code-")),
    cwd = join(root, "source");
  await git(root, ["init", "-q", cwd]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@localhost"]);
  await writeFile(join(cwd, "main.txt"), "original\n");
  await writeFile(join(cwd, ".gitignore"), "secret.env\nbuild/\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "Initial"]);
  const run: Run = {
    id: "run-code",
    name: "code",
    cwd,
    model: null,
    objective: "Improve code",
    created: new Date().toISOString(),
    desired: "running",
    rootTaskId: "task-code",
    catalog: null,
    limits: { ...DEFAULT_RUN_LIMITS },
    deadline: Date.now() + 60_000,
    repos: [],
    workspace: { includeUntracked: [] },
    inputArtifactId: null,
    integrationArtifactId: null,
    acceptedArtifactId: null,
  };
  const workspaces = new Workspaces(join(root, "state"));
  return { root, cwd, run, workspaces, close: () => rm(root, { recursive: true, force: true }) };
}

async function result(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Artifact,
  operation: string,
  files: Record<string, string>,
): Promise<Artifact> {
  const checkout = join(f.root, operation);
  await materialize(f, input, checkout);
  await git(checkout, ["config", "user.name", "Writer"]);
  await git(checkout, ["config", "user.email", "writer@localhost"]);
  for (const [name, text] of Object.entries(files)) await writeFile(join(checkout, name), text);
  await git(checkout, ["add", "-A"]);
  await git(checkout, ["commit", "-qm", operation]);
  const ref = `refs/pituitary/results/${createHash("sha256").update(operation).digest("hex")}`;
  await git(checkout, ["update-ref", ref, "HEAD"]);
  const bundle = join(f.root, `${operation}.bundle`);
  await git(checkout, ["bundle", "create", bundle, ref]);
  const context = {
    run: f.run,
    task: { id: `task-${operation}` },
    attempt: { id: `attempt-${operation}` },
  } as ExecutionContext;
  return f.workspaces.receive(context, input, await readFile(bundle), operation);
}

async function materialize(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Artifact,
  path: string,
): Promise<void> {
  await git(f.root, ["init", "-q", path]);
  await git(path, ["fetch", "-q", f.workspaces.bundle(input), input.head]);
  await git(path, ["checkout", "-q", "--detach", input.head]);
}

test("dirty input capture preserves HEAD, staged changes and files while selecting untracked inputs", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "main.txt"), "staged\n");
    await git(f.cwd, ["add", "main.txt"]);
    await writeFile(join(f.cwd, "main.txt"), "working\n");
    await writeFile(join(f.cwd, "selected.txt"), "included\n");
    await writeFile(join(f.cwd, "other.txt"), "not selected\n");
    await writeFile(join(f.cwd, "secret.env"), "private\n");
    f.run.workspace = { includeUntracked: ["selected.txt", "secret.env"] };
    const before = await git(f.cwd, ["status", "--porcelain=v1", "-z"]),
      index = await readFile(join(f.cwd, ".git/index"));
    const input = await f.workspaces.capture(f.run),
      checkout = join(f.root, "inspect");
    await materialize(f, input, checkout);
    expect(await readFile(join(checkout, "main.txt"), "utf8")).toBe("working\n");
    expect(await readFile(join(checkout, "selected.txt"), "utf8")).toBe("included\n");
    expect(await git(checkout, ["ls-files"])).toEqual(Buffer.from(".gitignore\nmain.txt\nselected.txt\n"));
    expect(await git(f.cwd, ["status", "--porcelain=v1", "-z"])).toEqual(before);
    expect(await readFile(join(f.cwd, ".git/index"))).toEqual(index);
    await writeFile(join(f.cwd, "main.txt"), "later change\n");
    expect(await f.workspaces.capture(f.run)).toEqual(input);
  } finally {
    await f.close();
  }
});

test("parallel immutable results merge and explicit apply preserves the original index", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "main.txt"), "operator staged\n");
    await git(f.cwd, ["add", "main.txt"]);
    await writeFile(join(f.cwd, "main.txt"), "operator dirty\n");
    const index = await readFile(join(f.cwd, ".git/index")),
      head = await git(f.cwd, ["rev-parse", "HEAD"]);
    const input = await f.workspaces.capture(f.run);
    const a = await result(f, input, "writer-a", { "a.txt": "A\n" }),
      b = await result(f, input, "writer-b", { "b.txt": "B\n" });
    const first = await f.workspaces.integrate(f.run, input, a, "integrate-a");
    const second = await f.workspaces.integrate(f.run, first.artifact as Artifact, b, "integrate-b");
    const accepted = second.artifact as Artifact;
    expect(first.conflicts).toBeUndefined();
    expect(second.conflicts).toBeUndefined();
    expect(await f.workspaces.integrate(f.run, first.artifact as Artifact, b, "integrate-b")).toEqual(second);
    f.run.acceptedArtifactId = accepted.id;
    f.run.integrationArtifactId = accepted.id;
    expect(await f.workspaces.apply(f.run, input, accepted)).toEqual({
      artifactId: accepted.id,
      applied: true,
    });
    expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(f.cwd, "b.txt"), "utf8")).toBe("B\n");
    expect(await readFile(join(f.cwd, "main.txt"), "utf8")).toBe("operator dirty\n");
    expect(await readFile(join(f.cwd, ".git/index"))).toEqual(index);
    expect(await git(f.cwd, ["rev-parse", "HEAD"])).toEqual(head);
    expect(await f.workspaces.apply(f.run, input, accepted)).toEqual({
      artifactId: accepted.id,
      applied: true,
    });
  } finally {
    await f.close();
  }
});

test("conflicts retain both results without advancing or changing the operator checkout", async () => {
  const f = await fixture();
  try {
    const input = await f.workspaces.capture(f.run),
      a = await result(f, input, "left", { "main.txt": "left\n" }),
      b = await result(f, input, "right", { "main.txt": "right\n" });
    const first = await f.workspaces.integrate(f.run, input, a, "left-integrated");
    const conflict = await f.workspaces.integrate(f.run, first.artifact as Artifact, b, "right-conflict");
    expect(conflict.artifact).toBeUndefined();
    expect(conflict.conflicts).toEqual(["main.txt"]);
    expect(await readFile(join(f.cwd, "main.txt"), "utf8")).toBe("original\n");
    expect((await readFile(f.workspaces.bundle(a))).length).toBe(a.bytes);
    expect((await readFile(f.workspaces.bundle(b))).length).toBe(b.bytes);
  } finally {
    await f.close();
  }
});

test("apply refuses changed input and unaccepted artifacts", async () => {
  const f = await fixture();
  try {
    const input = await f.workspaces.capture(f.run),
      a = await result(f, input, "change", { "main.txt": "result\n" });
    const accepted = (await f.workspaces.integrate(f.run, input, a, "integrated")).artifact as Artifact;
    await expect(f.workspaces.apply(f.run, input, accepted)).rejects.toThrow("no current verified result");
    f.run.acceptedArtifactId = accepted.id;
    f.run.integrationArtifactId = accepted.id;
    await writeFile(join(f.cwd, "main.txt"), "concurrent operator edit\n");
    await expect(f.workspaces.apply(f.run, input, accepted)).rejects.toThrow("workspace changed");
    expect(await readFile(join(f.cwd, "main.txt"), "utf8")).toBe("concurrent operator edit\n");
  } finally {
    await f.close();
  }
});

test("snapshot retains symlinks as data and rejects oversized source before dispatch", async () => {
  const f = await fixture();
  try {
    await symlink("/etc/passwd", join(f.cwd, "link"));
    f.run.workspace = { includeUntracked: ["link"] };
    const input = await f.workspaces.capture(f.run),
      checkout = join(f.root, "links");
    await materialize(f, input, checkout);
    expect((await git(checkout, ["ls-files", "--stage", "link"])).toString()).toStartWith("120000 ");
    f.run.id = "too-large";
    f.run.limits.artifactBytes = 2;
    await expect(f.workspaces.capture(f.run)).rejects.toThrow("artifact");
  } finally {
    await f.close();
  }
});
