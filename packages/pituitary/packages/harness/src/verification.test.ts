import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bayWorkspaceFixture } from "./bay-workspace.fixture.ts";
import type { AgentDefinition, VerificationPolicy } from "./catalog.ts";
import { DEFAULT_RUN_LIMITS, type Run, type Verification } from "./model.ts";
import { type VerificationCheckpoint, Verifier } from "./verification.ts";
import { git, Workspaces } from "./workspaces.ts";

async function fixture(checks: VerificationPolicy["checks"]) {
  const root = await mkdtemp("/tmp/pituitary-verification-"),
    cwd = join(root, "source");
  await git(root, ["init", "-q", cwd]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@localhost"]);
  await writeFile(join(cwd, "original.txt"), "original\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "Original"]);
  const agent: AgentDefinition = {
    program: "verifier",
    machine: "verifier",
    machineRevision: "a".repeat(64),
    manifest: {
      schemaVersion: 1,
      name: "verifier",
      description: "Run declared checks",
      instructions: "",
      model: null,
      tools: [],
      delegatesTo: [],
      credentials: [],
      limits: { maxChildren: 0, maxDepth: 0 },
    },
  };
  const bay = await bayWorkspaceFixture(root, { verifier: agent });
  const run: Run = {
    id: "run-verification",
    name: "verification",
    cwd,
    objective: "Verify retained code",
    model: null,
    created: new Date().toISOString(),
    desired: "running",
    rootTaskId: "task-verification",
    catalog: bay.catalog,
    limits: { ...DEFAULT_RUN_LIMITS },
    deadline: Date.now() + 60_000,
    repos: [],
    workspace: { includeUntracked: [] },
    inputArtifactId: null,
    integrationArtifactId: null,
    acceptedArtifactId: null,
  };
  const workspaces = new Workspaces(join(root, "state")),
    artifact = await workspaces.capture(run);
  const verification: Verification = {
    id: "verification",
    runId: run.id,
    taskId: run.rootTaskId,
    revision: 1,
    integrationId: "integration",
    artifactId: artifact.id,
    tree: artifact.tree,
    agent,
    policy: { agent: "verifier", checks },
    policyDigest: "declared-policy",
    status: "pending",
    checks: [],
    execution: null,
    error: null,
    created: new Date().toISOString(),
    completed: null,
  };
  let checkpoint: VerificationCheckpoint = {};
  return {
    bay,
    run,
    artifact,
    verification,
    verifier: new Verifier(workspaces, "test"),
    journal: {
      load: async () => structuredClone(checkpoint),
      save: async (value: VerificationCheckpoint) => {
        checkpoint = structuredClone(value);
      },
    },
    checkpoint: () => checkpoint,
    close: async () => {
      await bay.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("verification rejects a different artifact or tree before allocating its machine", async () => {
  const f = await fixture({ content: { command: ["true"], timeoutMs: 5000 } });
  try {
    for (const changed of [{ id: "different-artifact" }, { tree: "0".repeat(40) }])
      await expect(
        f.verifier.run(f.run, f.verification, { ...f.artifact, ...changed }, f.journal, () => true),
      ).rejects.toThrow("artifact does not match");
    expect(f.bay.guests.size).toBe(0);
    expect(f.checkpoint()).toEqual({});
  } finally {
    await f.close();
  }
});

test("verification detects source edits concealed by mutable Git index flags", async () => {
  const f = await fixture({
    tamper: {
      command: [
        "sh",
        "-c",
        "git update-index --assume-unchanged original.txt; printf changed > original.txt",
      ],
      timeoutMs: 5000,
    },
    later: { command: ["sh", "-c", "touch later-ran"], timeoutMs: 5000 },
  });
  try {
    const result = await f.verifier.run(f.run, f.verification, f.artifact, f.journal, () => true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      name: "tamper",
      status: "failed",
      output: expect.stringContaining("changed the source tree"),
    });
    const guest = f.bay.guests.get(result.verificationExecution.sessionName)!;
    expect(await readFile(join(guest.work, "workspace/original.txt"), "utf8")).toBe("changed");
    await expect(readFile(join(guest.work, "workspace/later-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(guest.session.state).toBe("suspended");
  } finally {
    await f.close();
  }
});

test("superseding a completed check prevents its evidence acknowledgement", async () => {
  const f = await fixture({ content: { command: ["true"], timeoutMs: 5000 } });
  try {
    const alive = () => {
      const completedSnapshots = [...f.bay.guests.values()]
        .flatMap((guest) => [...guest.jobs.values()])
        .filter((job) => job.argv[3] === "verify-tree" && job.status === "succeeded");
      return completedSnapshots.length < 2;
    };
    await expect(f.verifier.run(f.run, f.verification, f.artifact, f.journal, alive)).rejects.toThrow(
      "superseded before acknowledgement",
    );
    expect(f.checkpoint().result).toBeUndefined();
    expect([...f.bay.guests.values()].map((guest) => guest.session.state)).toEqual(["suspended"]);
  } finally {
    await f.close();
  }
});

test("superseding the pre-check snapshot prevents command dispatch", async () => {
  const f = await fixture({ content: { command: ["sh", "-c", "touch check-ran"], timeoutMs: 5000 } });
  try {
    const alive = () =>
      ![...f.bay.guests.values()]
        .flatMap((guest) => [...guest.jobs.values()])
        .some((job) => job.argv[3] === "verify-tree" && job.status === "succeeded");
    await expect(f.verifier.run(f.run, f.verification, f.artifact, f.journal, alive)).rejects.toThrow(
      "superseded before check dispatch",
    );
    const guest = [...f.bay.guests.values()][0]!;
    expect([...guest.jobs.values()].some((job) => job.argv.includes("touch check-ran"))).toBe(false);
    await expect(readFile(join(guest.work, "workspace/check-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.checkpoint().result).toBeUndefined();
    expect(guest.session.state).toBe("suspended");
  } finally {
    await f.close();
  }
});

test("verification marks bounded combined stdout and stderr as truncated", async () => {
  const f = await fixture({
    output: {
      command: [
        "sh",
        "-c",
        "head -c 131072 /dev/zero | tr '\\0' x; head -c 131072 /dev/zero | tr '\\0' y >&2",
      ],
      timeoutMs: 5000,
    },
  });
  try {
    const result = await f.verifier.run(f.run, f.verification, f.artifact, f.journal, () => true);
    expect(result.checks[0]).toMatchObject({ status: "passed", truncated: true });
    expect(Buffer.byteLength(result.checks[0]!.output)).toBe(256 * 1024);
    expect(f.checkpoint().result).toEqual(result);
  } finally {
    await f.close();
  }
});
