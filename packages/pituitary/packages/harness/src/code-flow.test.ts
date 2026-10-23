import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Bay } from "./bay.ts";
import { BayExecutionEnv } from "./bay-environment.ts";
import { bayWorkspaceFixture } from "./bay-workspace.fixture.ts";
import type { AgentDefinition } from "./catalog.ts";
import { rootAttempt, waitRun } from "./runtime.fixture.ts";
import { Runtime } from "./runtime.ts";
import { startRuntime } from "./supervisor.ts";
import { git } from "./workspaces.ts";

function role(name: string, tools: AgentDefinition["manifest"]["tools"]): AgentDefinition {
  return {
    manifest: {
      schemaVersion: 1,
      name,
      description: name,
      instructions: "Perform this assigned task, then submit your result.",
      model: "faux/faux-1",
      tools,
      delegatesTo: [],
      credentials: [],
      limits: { maxChildren: 0, maxDepth: 0 },
    },
    program: name,
    machine: name,
    machineRevision: (name === "writer" ? "a" : "b").repeat(64),
  };
}

test("the workspace fixture reports cancellation and keeps the environment usable", async () => {
  const root = await mkdtemp("/tmp/pituitary-fixture-cancel-"),
    writer = role("writer", ["bash"]),
    bay = await bayWorkspaceFixture(root, { writer });
  const session = await new Bay(bay.catalog.baySocket).start("one", writer, []),
    env = new BayExecutionEnv(
      {
        kind: "bay",
        socket: bay.catalog.baySocket,
        sessionName: session.name,
        recordId: session.id,
        generation: session.generation,
        agent: writer,
        repos: [],
      },
      ".",
    );
  try {
    const abort = new AbortController(),
      command = env.exec(
        "printf ready; sleep 30",
        {
          onOutput: () => abort.abort(),
        },
        withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
      );
    expect(await command).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(await env.exec("printf available", undefined, BACKGROUND_CONTEXT)).toMatchObject({
      ok: true,
      value: { exitCode: 0 },
    });
  } finally {
    await env.close();
    await bay.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

test("a native model writes through Bay, retains code, verifies in a fresh machine and applies explicitly across restart", async () => {
  const root = await mkdtemp("/tmp/pituitary-native-code-"),
    cwd = join(root, "source"),
    stateDirectory = join(root, "state");
  await git(root, ["init", "-q", cwd]);
  await git(cwd, ["config", "user.name", "Operator"]);
  await git(cwd, ["config", "user.email", "operator@localhost"]);
  await writeFile(join(cwd, "original.txt"), "original\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "Original"]);
  await writeFile(join(cwd, "original.txt"), "operator staged\n");
  await git(cwd, ["add", "original.txt"]);
  await writeFile(join(cwd, "original.txt"), "operator working\n");
  const originalHead = await git(cwd, ["rev-parse", "HEAD"]),
    originalIndex = await readFile(join(cwd, ".git/index"));
  const writer = role("writer", ["read", "write", "bash"]),
    verifier = role("verifier", []);
  writer.verification = {
    agent: "verifier",
    checks: {
      content: {
        command: [
          "sh",
          "-c",
          "test \"$(cat result.txt)\" = 'retained change'; test \"$(cat original.txt)\" = 'operator working'",
        ],
        timeoutMs: 10_000,
      },
    },
  };
  let releaseCheck!: () => void,
    checkPaused = false;
  const checkGate = new Promise<void>((resolve) => (releaseCheck = resolve));
  const bay = await bayWorkspaceFixture(
      root,
      { writer, verifier },
      {
        beforeJob: async (session, command) => {
          if (session.machine === "verifier" && command.argv[0] === "sh") {
            checkPaused = true;
            await checkGate;
          }
        },
      },
    ),
    faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "retained change\n" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "cat /work/workspace/result.txt; printf guest > /tmp/result.txt; cat /tmp/result.txt",
        timeout: 5,
      }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage(
      fauxToolCall("submit", { summary: "Retained the requested code change.", artifact: true }),
      { stopReason: "toolUse" },
    ),
  ]);
  const options = { stateDirectory, catalog: bay.catalog, models };
  let host = await startRuntime(options);
  try {
    const runtime = new Runtime({ stateDirectory, autoStart: false });
    const run = await runtime.start({
      name: "native-code",
      cwd,
      agent: "writer",
      prompt: "Write and submit result.txt.",
      workspace: { includeUntracked: [] },
    });
    const submitted = await waitRun(
      runtime,
      run.id,
      (detail) => checkPaused && !!detail.tasks.find((task) => task.id === detail.run.rootTaskId)?.artifactId,
      30_000,
    );
    expect(submitted.tasks.find((task) => task.id === submitted.run.rootTaskId)?.artifactId).toBeTruthy();
    expect(submitted.run.acceptedArtifactId).toBeNull();
    expect(submitted.artifacts.filter((artifact) => artifact.kind === "result")).toHaveLength(1);
    expect(bay.environmentOperations).toContain("openWrite");
    expect(bay.environmentOperations).toContain("writeChunk");
    expect(bay.environmentOperations).toContain("exec");
    expect(faux.state.callCount).toBe(3);
    expect(await readFile(join(cwd, "original.txt"), "utf8")).toBe("operator working\n");
    await expect(readFile(join(cwd, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const sourceSession = rootAttempt(submitted).execution!.sessionName,
      sourceGuest = bay.guests.get(sourceSession)!;
    expect(await readFile(join(sourceGuest.work, "workspace/result.txt"), "utf8")).toBe("retained change\n");
    expect(await readFile(join(sourceGuest.temporary, "result.txt"), "utf8")).toBe("guest");
    await host.close();
    host = await startRuntime(options);
    expect(faux.state.callCount).toBe(3);
    const restored = new Runtime({ stateDirectory, autoStart: false });
    releaseCheck();
    const accepted = await waitRun(restored, run.id, (detail) => !!detail.run.acceptedArtifactId, 30_000);
    const acceptedArtifactId = accepted.run.acceptedArtifactId;
    if (!acceptedArtifactId) throw new Error("Run did not retain its accepted artifact");
    expect(accepted.verifications).toHaveLength(1);
    expect(accepted.verifications[0]?.status).toBe("passed");
    const verification = accepted.verifications[0]!;
    expect(verification.execution!.sessionName).not.toBe(sourceSession);
    const verificationGuest = bay.guests.get(verification.execution!.sessionName)!;
    expect(verificationGuest.session.machine).toBe("verifier");
    expect(verificationGuest.session.state).toBe("suspended");
    expect(faux.state.callCount).toBe(3);
    expect([...bay.dispatches.values()].every((count) => count === 1)).toBe(true);
    expect(await restored.apply(run.id, "apply-native-result")).toEqual({
      artifactId: acceptedArtifactId,
      applied: true,
    });
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("retained change\n");
    expect(await git(cwd, ["rev-parse", "HEAD"])).toEqual(originalHead);
    expect(await readFile(join(cwd, ".git/index"))).toEqual(originalIndex);
    expect(await restored.apply(run.id, "apply-native-result")).toEqual({
      artifactId: acceptedArtifactId,
      applied: true,
    });
    const archived = await restored.attach(run.id);
    expect(archived.controlsInput).toBe(false);
    expect(JSON.stringify(await archived.getMessages())).toContain("retained change");
    await archived.close();
  } finally {
    releaseCheck();
    await host.close();
    await bay.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("stop reconciles and suspends a verifier allocated before its launch response arrives", async () => {
  const root = await mkdtemp("/tmp/pituitary-native-verifier-create-"),
    cwd = join(root, "source"),
    stateDirectory = join(root, "state");
  await git(root, ["init", "-q", cwd]);
  await git(cwd, ["config", "user.name", "Operator"]);
  await git(cwd, ["config", "user.email", "operator@localhost"]);
  await writeFile(join(cwd, "original.txt"), "original\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "Original"]);
  const writer = role("writer", ["write"]),
    verifier = role("verifier", []);
  writer.verification = {
    agent: "verifier",
    checks: { content: { command: ["sh", "-c", "test -f result.txt"], timeoutMs: 10_000 } },
  };
  let release!: () => void,
    launches = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bay = await bayWorkspaceFixture(
    root,
    { writer, verifier },
    {
      beforeStart: async (session) => {
        if (session.machine === "verifier") {
          launches++;
          await gate;
        }
      },
    },
  );
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "retained change\n" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("submit", { summary: "Retain this code.", artifact: true }), {
      stopReason: "toolUse",
    }),
  ]);
  const host = await startRuntime({ stateDirectory, catalog: bay.catalog, models });
  try {
    const runtime = new Runtime({ stateDirectory, autoStart: false }),
      run = await runtime.start({
        cwd,
        agent: "writer",
        prompt: "Write and submit result.txt.",
        workspace: { includeUntracked: [] },
      });
    const pending = await waitRun(
      runtime,
      run.id,
      (detail) => launches === 1 && detail.verifications.length === 1,
      30_000,
    );
    expect(pending.verifications[0]!.execution).toBeNull();
    const guest = [...bay.guests.values()].find((item) => item.session.machine === "verifier")!;
    expect(guest.session.state).toBe("running");
    await runtime.stop(run.id);
    const stopped = await runtime.inspect(run.id),
      verification = stopped.verifications[0]!;
    expect(verification.status).toBe("cancelled");
    expect(stopped.tasks.find((task) => task.id === stopped.run.rootTaskId)).toMatchObject({
      status: "cancelled",
      verificationId: null,
    });
    expect(verification.execution).toEqual({
      sessionName: guest.session.name,
      recordId: guest.session.id,
      generation: guest.session.generation,
    });
    expect(guest.session.state).toBe("suspended");
    expect([...bay.guests.values()].every((item) => item.session.state === "suspended")).toBe(true);
    expect(stopped.run.acceptedArtifactId).toBeNull();
    expect(launches).toBe(1);
    expect(faux.state.callCount).toBe(2);
  } finally {
    release();
    await host.close();
    await bay.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("independent native storage namespaces cannot collide or adopt each other's Bay machines", async () => {
  const root = await mkdtemp("/tmp/pituitary-native-namespaces-"),
    writer = role("writer", []),
    bay = await bayWorkspaceFixture(root, { writer }),
    faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  const firstState = join(root, "first"),
    secondState = join(root, "second"),
    first = await startRuntime({ stateDirectory: firstState, catalog: bay.catalog, models });
  let second: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    second = await startRuntime({ stateDirectory: secondState, catalog: bay.catalog, models });
    const a = new Runtime({ stateDirectory: firstState, autoStart: false }),
      b = new Runtime({ stateDirectory: secondState, autoStart: false });
    const [runA, runB] = await Promise.all([
      a.start({ cwd: root, agent: "writer" }),
      b.start({ cwd: root, agent: "writer" }),
    ]);
    const [readyA, readyB] = await Promise.all([
      waitRun(a, runA.id, (detail) => !!rootAttempt(detail).conversationId),
      waitRun(b, runB.id, (detail) => !!rootAttempt(detail).conversationId),
    ]);
    expect(rootAttempt(readyA).id).toBe(rootAttempt(readyB).id);
    const executionA = rootAttempt(readyA).execution!,
      executionB = rootAttempt(readyB).execution!;
    expect(executionA.sessionName).not.toBe(executionB.sessionName);
    expect(executionA.recordId).not.toBe(executionB.recordId);
    expect(bay.guests.size).toBe(2);
    expect(faux.state.callCount).toBe(0);
  } finally {
    await second?.close();
    await first.close();
    await bay.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("a replacement revision drops withdrawn code instead of implicitly adopting its prior integration", async () => {
  const root = await mkdtemp("/tmp/pituitary-native-revision-"),
    cwd = join(root, "source"),
    stateDirectory = join(root, "state");
  await git(root, ["init", "-q", cwd]);
  await git(cwd, ["config", "user.name", "Operator"]);
  await git(cwd, ["config", "user.email", "operator@localhost"]);
  await writeFile(join(cwd, "original.txt"), "original\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "Original"]);
  const writer = role("writer", ["write"]),
    verifier = role("verifier", []);
  writer.verification = {
    agent: "verifier",
    checks: { content: { command: ["sh", "-c", "test -f kept.txt"], timeoutMs: 10_000 } },
  };
  const bay = await bayWorkspaceFixture(root, { writer, verifier }),
    faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "obsolete.txt", content: "withdraw this contribution\n" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxToolCall("write", { path: "kept.txt", content: "first revision\n" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("submit", { summary: "First proposal.", artifact: true }), {
      stopReason: "toolUse",
    }),
  ]);
  const host = await startRuntime({ stateDirectory, catalog: bay.catalog, models });
  try {
    const runtime = new Runtime({ stateDirectory, autoStart: false }),
      run = await runtime.start({
        name: "revisions",
        cwd,
        agent: "writer",
        prompt: "First proposal",
        workspace: { includeUntracked: [] },
      });
    const first = await waitRun(runtime, run.id, (detail) => !!detail.run.acceptedArtifactId, 30_000),
      task = first.tasks.find((task) => task.id === first.run.rootTaskId)!;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "kept.txt", content: "replacement revision\n" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall("submit", { summary: "Replacement excludes the withdrawn extra file.", artifact: true }),
        { stopReason: "toolUse" },
      ),
    ]);
    await runtime.revise(task.id, task.revision, {
      objective: "Replace the first proposal; omit its obsolete file.",
    });
    const second = await waitRun(
        runtime,
        run.id,
        (detail) =>
          !!detail.run.acceptedArtifactId && detail.run.acceptedArtifactId !== first.run.acceptedArtifactId,
        30_000,
      ),
      replacement = second.tasks.find((item) => item.id === task.id)!;
    expect(replacement.revision).toBe(2);
    expect(replacement.inputArtifactId).toBe(run.inputArtifactId ?? first.run.inputArtifactId);
    expect(second.reports.map((report) => report.revision)).toEqual([1, 2]);
    expect(second.artifacts.filter((artifact) => artifact.kind === "result")).toHaveLength(2);
    expect(second.verifications.find((item) => item.id === task.verificationId)?.status).toBe("stale");
    const execution = rootAttempt(second).execution!,
      guest = bay.guests.get(execution.sessionName)!;
    await expect(readFile(join(guest.work, "workspace/obsolete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await runtime.apply(run.id);
    expect(await readFile(join(cwd, "kept.txt"), "utf8")).toBe("replacement revision\n");
    await expect(readFile(join(cwd, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(second.events.find((event) => event.type === "task_revised")?.data.explicitInput).toBe(false);
  } finally {
    await host.close();
    await bay.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("withdrawing a child report revokes an exporting ancestor while preserving independent sibling results", async () => {
  const root = await mkdtemp("/tmp/pituitary-native-withdraw-"),
    cwd = join(root, "source"),
    stateDirectory = join(root, "state");
  await git(root, ["init", "-q", cwd]);
  await git(cwd, ["config", "user.name", "Operator"]);
  await git(cwd, ["config", "user.email", "operator@localhost"]);
  await writeFile(join(cwd, "original.txt"), "original\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "Original"]);
  const coordinator = role("coordinator", ["write"]),
    reader = role("reader", []);
  coordinator.manifest.delegatesTo = ["reader"];
  coordinator.manifest.limits = { maxChildren: 2, maxDepth: 1 };
  let release!: () => void,
    paused = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bay = await bayWorkspaceFixture(
    root,
    { coordinator, reader },
    {
      beforeJob: async (session, command) => {
        if (session.machine === "coordinator" && command.argv.includes("pituitary-export")) {
          paused = true;
          await gate;
        }
      },
    },
  );
  const faux = fauxProvider(),
    models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 40 }, () => async (transcript) => {
      const first = transcript.messages.find((message) => message.role === "user"),
        initial = JSON.stringify(first),
        last = transcript.messages.at(-1);
      if (initial.includes("Primary") || initial.includes("Sibling"))
        return fauxAssistantMessage(
          fauxToolCall("submit", {
            summary: initial.includes("Sibling") ? "Independent sibling facts." : "Primary facts.",
          }),
          { stopReason: "toolUse" },
        );
      const delegated = transcript.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.content.filter((part) => part.type === "toolCall" && part.name === "delegate")
          : [],
      ).length;
      if (delegated < 2)
        return fauxAssistantMessage(
          fauxToolCall("delegate", {
            agent: "reader",
            objective: delegated ? "Sibling task" : "Primary task",
          }),
          { stopReason: "toolUse" },
        );
      if (last?.role === "toolResult" && last.toolName === "write")
        return fauxAssistantMessage(
          fauxToolCall("submit", {
            summary: "Ancestor completion based on both child reports.",
            artifact: true,
          }),
          { stopReason: "toolUse" },
        );
      const reports = (
        JSON.stringify(transcript.messages.filter((message) => message.role === "user")).match(
          /submitted unverified report/g,
        ) ?? []
      ).length;
      if (reports >= 2)
        return fauxAssistantMessage(
          fauxToolCall("write", { path: "result.txt", content: "unretained ancestor output\n" }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(fauxToolCall("yield", { reason: "Waiting for both reports" }), {
        stopReason: "toolUse",
      });
    }),
  );
  const host = await startRuntime({ stateDirectory, catalog: bay.catalog, models });
  try {
    const runtime = new Runtime({ stateDirectory, autoStart: false }),
      run = await runtime.start({
        name: "withdraw",
        cwd,
        agent: "coordinator",
        prompt: "Coordinate reports and propose code.",
        workspace: { includeUntracked: [] },
      });
    const exporting = await waitRun(
      runtime,
      run.id,
      (detail) =>
        paused && detail.tasks.find((task) => task.id === detail.run.rootTaskId)?.status === "submitting",
      30_000,
    );
    const parent = exporting.tasks.find((task) => task.id === exporting.run.rootTaskId)!,
      primary = exporting.tasks.find((task) => task.objective === "Primary task")!,
      sibling = exporting.tasks.find((task) => task.objective === "Sibling task")!;
    expect(parent.reportId).toBeTruthy();
    expect(sibling.reportId).toBeTruthy();
    await runtime.revise(primary.id, primary.revision, { objective: "Primary revised task" });
    const revoked = await waitRun(
        runtime,
        run.id,
        (detail) =>
          detail.attempts.find((attempt) => attempt.id === parent.currentAttemptId)?.status === "stopped",
        30_000,
      ),
      withdrawn = revoked.tasks.find((task) => task.id === parent.id)!;
    expect(withdrawn.status).toBe("superseded");
    expect(withdrawn.reportId).toBeNull();
    expect(withdrawn.artifactId).toBeNull();
    expect(revoked.tasks.find((task) => task.id === sibling.id)?.reportId).toBe(sibling.reportId);
    expect(revoked.reports.some((report) => report.id === parent.reportId)).toBe(true);
    expect(
      revoked.artifacts.some((artifact) => artifact.taskId === parent.id && artifact.kind === "result"),
    ).toBe(false);
    expect(revoked.run.acceptedArtifactId).toBeNull();
    expect(revoked.attempts.find((attempt) => attempt.id === parent.currentAttemptId)?.desired).toBe(
      "stopped",
    );
  } finally {
    release();
    await host.close();
    await bay.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

for (const outcome of ["conflict", "verification failure"] as const)
  test(`a yielded coordinator wakes after child ${outcome}`, async () => {
    const root = await mkdtemp("/tmp/pituitary-native-parent-notice-"),
      cwd = join(root, "source"),
      stateDirectory = join(root, "state");
    await git(root, ["init", "-q", cwd]);
    await git(cwd, ["config", "user.name", "Operator"]);
    await git(cwd, ["config", "user.email", "operator@localhost"]);
    await writeFile(join(cwd, "shared.txt"), "original\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-qm", "Original"]);
    const coordinator = role("coordinator", []),
      writer = role("writer", ["write"]),
      verifier = role("verifier", []);
    coordinator.manifest.delegatesTo = ["writer"];
    coordinator.manifest.limits = { maxChildren: 2, maxDepth: 1 };
    if (outcome === "verification failure")
      writer.verification = {
        agent: "verifier",
        checks: { unit: { command: ["sh", "-c", "true"], timeoutMs: 10_000 } },
      };
    let sawFirstReport!: () => void;
    const firstReport = new Promise<void>((resolve) => (sawFirstReport = resolve));
    const bay = await bayWorkspaceFixture(
      root,
      { coordinator, writer, verifier },
      {
        beforeStart: async (session) => {
          if (session.machine === "verifier") {
            await firstReport;
            throw new Error("Verifier machine unavailable");
          }
        },
      },
    );
    const faux = fauxProvider(),
      models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 40 }, () => async (transcript) => {
        const first = JSON.stringify(transcript.messages.find((message) => message.role === "user")),
          last = transcript.messages.at(-1);
        if (first.includes("Child A") || first.includes("Child B"))
          return fauxAssistantMessage(
            last?.role === "toolResult" && last.toolName === "write"
              ? fauxToolCall("submit", { summary: "Child code result.", artifact: true })
              : fauxToolCall("write", {
                  path: "shared.txt",
                  content: first.includes("Child A") ? "first\n" : "second\n",
                }),
            { stopReason: "toolUse" },
          );
        const delegated = transcript.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.filter((part) => part.type === "toolCall" && part.name === "delegate")
            : [],
        ).length;
        if (delegated < (outcome === "conflict" ? 2 : 1))
          return fauxAssistantMessage(
            fauxToolCall("delegate", { agent: "writer", objective: delegated ? "Child B" : "Child A" }),
            { stopReason: "toolUse" },
          );
        const notice = last?.role === "user" ? JSON.stringify(last.content) : "";
        if (notice.includes("submitted unverified report")) sawFirstReport();
        if (
          (notice.includes("Integration ") && notice.includes("conflicted")) ||
          (notice.includes("Independent verification ") && notice.includes("failed"))
        )
          return fauxAssistantMessage(fauxToolCall("ask", { question: "Resolve the child result?" }), {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage(fauxToolCall("yield", { reason: "Awaiting child outcome" }), {
          stopReason: "toolUse",
        });
      }),
    );
    const host = await startRuntime({ stateDirectory, catalog: bay.catalog, models });
    try {
      const runtime = new Runtime({ stateDirectory, autoStart: false }),
        run = await runtime.start({
          cwd,
          agent: "coordinator",
          prompt: "Coordinate child code.",
          workspace: {},
        });
      const detail = await waitRun(
        runtime,
        run.id,
        (detail) => detail.questions.some((question) => question.taskId === detail.run.rootTaskId),
        30_000,
      );
      if (outcome === "conflict") {
        expect(detail.integrations.some((integration) => integration.status === "conflicted")).toBe(true);
        expect(detail.tasks.some((task) => task.status === "conflicted")).toBe(true);
      } else {
        expect(detail.verifications[0]?.status).toBe("failed");
        expect(detail.verifications[0]?.error).toContain("Verifier machine unavailable");
      }
    } finally {
      sawFirstReport();
      await host.close();
      await bay.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
