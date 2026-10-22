import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fakeModels, stored } from "@pituitary/rpc";
import type { DomainCommand } from "./domain-protocol.ts";
import {
  createNativeEngine,
  createNativeInbox,
  createOrchestrationTools,
  installOrchestrationGuards,
  snapshotNativeSession,
} from "./pi-engine.ts";
import type { AgentManifest } from "./protocol.ts";

test("native inbox delivery is attributed, durable and idempotent without writing provisioned credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-inbox-"));
  const role: AgentManifest = {
    schemaVersion: 1,
    name: "reader",
    description: "Read",
    instructions: "Read the assigned work.",
    model: null,
    tools: ["read"],
    delegatesTo: [],
    credentials: ["model"],
  };
  const context = {
    cwd: root,
    stateDirectory: root,
    configDirectory: join(root, "config"),
    role,
    assignment: { runId: "run-1", taskId: "task-1", attemptId: "attempt-1", epoch: 1 },
    apiKeys: { anthropic: "secret-native-memory-only" },
    domain: async () => ({}),
    onEvent: () => {},
    onUiRequest: () => {},
    onUiClose: () => {},
  };
  let engine = await createNativeEngine(context);
  const input = {
    type: "deliver" as const,
    batchId: "batch-1",
    messages: [
      {
        id: "message-1",
        from: "attempt-parent",
        taskId: "task-parent",
        body: "Use the accepted interface.",
        replyTo: "question-1",
      },
    ],
    wake: false,
  };
  try {
    if (!engine.deliver || !engine.deliveryStatus) throw new Error("Missing inbox API");
    const saved = await engine.deliver(input);
    expect(saved.duplicate).toBe(false);
    expect(engine.deliveryStatus("batch-1").entryId).toBe(saved.entryId);
    expect((await engine.deliver(input)).duplicate).toBe(true);
    const firstMessage = input.messages[0];
    if (!firstMessage) throw new Error("Missing test message");
    await expect(
      engine.deliver({ ...input, messages: [{ ...firstMessage, body: "Changed" }] }),
    ).rejects.toThrow("another payload");
    const messages = await engine.call({ type: "get_messages" });
    expect(JSON.stringify(messages)).toContain(
      "Message message-1 from attempt-parent · task task-parent · reply to question-1",
    );
    const state = (await engine.call({ type: "get_state" })) as { sessionFile: string; sessionId: string };
    expect(readFileSync(state.sessionFile, "utf8")).toContain("Use the accepted interface");
    await engine.close();
    engine = await createNativeEngine({
      ...context,
      sessionFile: state.sessionFile,
      sessionId: state.sessionId,
    });
    expect((await engine.deliver?.(input))?.duplicate).toBe(true);
    for (const file of readdirSync(root, { recursive: true })) {
      const name = String(file);
      if (name.endsWith(".json") || name.endsWith(".jsonl"))
        expect(readFileSync(join(root, name), "utf8")).not.toContain("secret-native-memory-only");
    }
    expect(existsSync(join(root, "config", "auth.json"))).toBe(false);
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function scriptedOrchestration(steps: ToolCall[][], persistent = false) {
  const root = mkdtempSync(join(tmpdir(), "pi-domain-tools-"));
  const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const model = fakeModels[0];
  if (!model) throw new Error("Missing scripted model");
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerProvider(model.provider, {
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: "local-fixture-only",
    models: [model],
  });
  const role: AgentManifest = {
    schemaVersion: 1,
    name: "coordinator",
    description: "Coordinate",
    instructions: "Delegate and respond to collaborators.",
    model: null,
    tools: ["bash"],
    delegatesTo: ["builder"],
    credentials: [],
  };
  const requests: Array<{ entry: string; call: string; command: DomainCommand }> = [];
  const orchestration = createOrchestrationTools({
    role,
    assignment: { runId: "run-1", taskId: "task-1", attemptId: "attempt-1", epoch: 1 },
    domain: async (entry, call, command) => {
      requests.push({ entry, call, command });
      if (command.type === "delegate")
        return { taskId: "child-task", attemptId: "child-attempt", status: "queued" };
      if (command.type === "message") return { messageId: "answer-1", delivery: "queued" };
      if (command.type === "submit") return { resultId: "result-1", status: "proposed" };
      return { waiting: true };
    },
  });
  let manager = SessionManager.inMemory(root);
  if (persistent) {
    const path = join(root, "session.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    manager = SessionManager.open(path, root, root);
  }
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: loader,
    modelRuntime: models,
    model,
    tools: [...role.tools, ...orchestration.tools.map((tool) => tool.name)],
    customTools: orchestration.tools,
  });
  installOrchestrationGuards(session, orchestration.terminalCalls);
  let turns = 0;
  session.agent.streamFunction = () => {
    const calls = steps[turns++];
    if (!calls) throw new Error("Unexpected extra model turn");
    const base = stored.assistant({ text: "" });
    if (base.role !== "assistant") throw new Error("Missing scripted assistant");
    const message: AssistantMessage = { ...base, content: calls, stopReason: "toolUse" };
    // Pi consumes the local iterable/result contract; this fixture has no provider queue.
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "toolUse", message };
      },
      async result() {
        return message;
      },
    } as unknown as Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
  };
  return {
    root,
    session,
    requests,
    get turns() {
      return turns;
    },
    async close() {
      await session.abort();
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

test("native wake delivery acknowledges saved history while its turn is held and retries busy batches safely", async () => {
  const example = await scriptedOrchestration(
    [[call("yield-1", "yield", {})], [call("yield-2", "yield", {})]],
    true,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = example.session.agent.streamFunction;
  example.session.agent.streamFunction = async (...args) => {
    const stream = await original(...args);
    return {
      async *[Symbol.asyncIterator]() {
        await held;
        for await (const event of stream) yield event;
      },
      result: () => stream.result(),
    } as unknown as typeof stream;
  };
  const active = new Set<Promise<unknown>>();
  const inbox = createNativeInbox(example.session, active, () => {});
  const message = { id: "question-1", from: "child-task", body: "Which interface should I implement?" };
  const delivery = {
    type: "deliver" as const,
    batchId: "question-1",
    messages: [message],
    wake: true,
  };
  try {
    const receipt = await inbox.deliver(delivery);
    expect(receipt.duplicate).toBe(false);
    expect(inbox.deliveryStatus(delivery.batchId).entryId).toBe(receipt.entryId);
    expect(example.session.isStreaming).toBe(true);
    expect(readFileSync(example.session.sessionFile as string, "utf8")).toContain(message.body);
    expect((await inbox.deliver(delivery)).duplicate).toBe(true);
    const second = {
      ...delivery,
      batchId: "question-2",
      messages: [{ ...message, id: "question-2" }],
    };
    await expect(inbox.deliver(second)).rejects.toThrow("busy");
    expect(inbox.deliveryStatus(second.batchId).entryId).toBeNull();
    release();
    await example.session.agent.waitForIdle();
    await Promise.allSettled([...active]);
    expect(example.turns).toBe(1);
    expect((await inbox.deliver(second)).duplicate).toBe(false);
    await example.session.agent.waitForIdle();
    await Promise.allSettled([...active]);
    expect(example.turns).toBe(2);
    expect(
      example.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "pituitary.delivery"),
    ).toHaveLength(2);
  } finally {
    release();
    await example.close();
    await Promise.allSettled([...active]);
  }
});

test("native orchestration tools delegate, yield, answer a question and submit without polling turns", async () => {
  const example = await scriptedOrchestration([
    [call("delegate-1", "delegate", { agent: "builder", objective: "Implement the interface" })],
    [call("yield-1", "yield", { reason: "Waiting for the builder" })],
    [
      call("answer-1", "message", {
        to: "child-task",
        body: "Use the existing interface",
        replyTo: "question-1",
      }),
    ],
    [call("yield-2", "yield", {})],
    [call("submit-1", "submit", { summary: "The builder finished the requested report." })],
  ]);
  try {
    const original = example.session.sessionId;
    await example.session.prompt("Coordinate the work");
    expect(example.turns).toBe(2);
    expect(example.session.isStreaming).toBe(false);
    await example.session.sendCustomMessage(
      {
        customType: "pituitary.delivery",
        content: "[Message question-1 from child-attempt · task child-task]\nWhich interface should I use?",
        display: true,
      },
      { triggerTurn: true },
    );
    expect(example.turns).toBe(4);
    expect(example.session.isStreaming).toBe(false);
    await example.session.sendCustomMessage(
      {
        customType: "pituitary.delivery",
        content: "[Result result-child from child-attempt · task child-task]\nThe report is complete.",
        display: true,
      },
      { triggerTurn: true },
    );
    expect(example.turns).toBe(5);
    expect(example.session.sessionId).toBe(original);
    expect(example.requests.map((request) => request.command.type)).toEqual([
      "delegate",
      "yield",
      "message",
      "yield",
      "submit",
    ]);
    expect(example.requests.every((request) => request.entry && request.call)).toBe(true);
    expect(new Set(example.requests.map((request) => request.entry)).size).toBe(5);
    expect(example.session.getActiveToolNames()).toEqual(
      expect.arrayContaining(["delegate", "inspect", "message", "submit", "yield"]),
    );
  } finally {
    await example.close();
  }
});

test("mixed yielding or submitting batches execute no sibling effects", async () => {
  for (const terminal of ["yield", "submit"] as const) {
    const example = await scriptedOrchestration([
      [
        call("shell-1", "bash", { command: "touch should-not-exist" }),
        call("terminal-1", terminal, terminal === "submit" ? { summary: "Premature report" } : {}),
      ],
      [call("terminal-2", terminal, terminal === "submit" ? { summary: "Valid report" } : {})],
    ]);
    try {
      await example.session.prompt("Run the test batch");
      expect(example.turns).toBe(2);
      expect(example.requests.map((request) => request.call)).toEqual(["terminal-2"]);
      expect(existsSync(join(example.root, "should-not-exist"))).toBe(false);
      expect(JSON.stringify(example.session.messages)).toContain("only tool call in their batch");
    } finally {
      await example.close();
    }
  }
});

test("a declared role cannot gain an undeclared shell or change model through interactive RPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-role-"));
  const role: AgentManifest = {
    schemaVersion: 1,
    name: "reader",
    description: "Read a change",
    instructions: "Inspect the supplied change.",
    model: null,
    tools: ["read", "grep"],
    delegatesTo: [],
    credentials: [],
  };
  const engine = await createNativeEngine({
    cwd: root,
    stateDirectory: root,
    configDirectory: join(root, "config"),
    authFile: join(root, "auth.json"),
    instructions: role.instructions,
    role,
    onEvent: () => {},
    onUiRequest: () => {},
    onUiClose: () => {},
  });
  try {
    await expect(engine.call({ type: "bash", command: "touch should-not-exist" })).rejects.toThrow(
      "does not enable",
    );
    await expect(engine.call({ type: "set_model", provider: "any", modelId: "other" })).rejects.toThrow(
      "declared by the agent role",
    );
    await expect(engine.call({ type: "cycle_model" })).rejects.toThrow("declared by the agent role");
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native recovery restores a known domain receipt without reissuing an unknown shell effect", async () => {
  for (const tool of ["delegate", "bash"] as const) {
    const root = mkdtempSync(join(tmpdir(), "pi-tool-recovery-"));
    const manager = SessionManager.create(root, join(root, "sessions"));
    manager.appendMessage({ role: "user", content: "Perform the work", timestamp: Date.now() });
    const requested = stored.assistant({
      toolCall: {
        id: "interrupted-call",
        name: tool,
        args:
          tool === "delegate"
            ? { agent: "builder", objective: "Implement the interface" }
            : { command: "touch uncertain" },
      },
    });
    if (requested.role !== "assistant") throw new Error("Missing assistant fixture");
    manager.appendMessage(requested);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("Missing native session file");
    let recoveries = 0;
    const context = {
      cwd: root,
      stateDirectory: root,
      configDirectory: join(root, "config"),
      sessionFile,
      sessionId: manager.getSessionId(),
      assignment: { runId: "run-1", taskId: "task-1", attemptId: "attempt-1", epoch: 1 },
      apiKeys: {},
      role: {
        schemaVersion: 1 as const,
        name: "coordinator",
        description: "Coordinate",
        instructions: "Delegate",
        model: null,
        tools: ["bash" as const],
        delegatesTo: ["builder"],
        credentials: [],
      },
      domain: async () => {
        throw new Error("A new domain effect must never be started from history");
      },
      recoverDomain: async () => {
        recoveries++;
        return {
          type: "domain_result" as const,
          id: "known-receipt",
          success: true as const,
          data: { taskId: "existing-child" },
        };
      },
      onEvent: () => {},
      onUiRequest: () => {},
      onUiClose: () => {},
    };
    try {
      if (tool === "bash") {
        await expect(createNativeEngine(context)).rejects.toThrow("native tool outcome is uncertain");
        expect(recoveries).toBe(0);
      } else {
        const engine = await createNativeEngine(context);
        try {
          expect(JSON.stringify(await engine.call({ type: "get_messages" }))).toContain("existing-child");
        } finally {
          await engine.close();
        }
        expect(recoveries).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a native snapshot captures a live SDK reply and queue without sharing mutable state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
  const settings = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  let session: AgentSession | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running: Promise<void> | undefined;
  try {
    await resourceLoader.reload();
    const model = fakeModels[0];
    if (!model) throw new Error("scripted model is missing");
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: "local-fixture-only",
      models: [model],
    });
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      sessionManager: SessionManager.inMemory(root),
      settingsManager: settings,
      resourceLoader,
      modelRuntime,
      model,
    }));
    const partial = stored.assistant({ text: "half a reply" });
    if (partial.role !== "assistant") throw new Error("scripted assistant message is missing");
    const completed = { ...partial, content: [{ type: "text" as const, text: "complete reply" }] };
    // The core receives a local scripted stream. No provider API or credential is involved.
    // Pi consumes only the iterable and result; this fixture owns no provider queue.
    session.agent.streamFunction = () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial };
          yield { type: "text_delta", contentIndex: 0, delta: "half a reply", partial };
          await held;
          yield { type: "done", reason: "stop", message: completed };
        },
        async result() {
          await held;
          return completed;
        },
      }) as unknown as Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
    const started = new Promise<void>((resolve) => {
      session?.subscribe((event) => {
        if (event.type === "message_update") resolve();
      });
    });
    running = session.prompt("produce the local scripted reply");
    await started;
    await session.steer("queued for the next safe boundary");
    const snapshot = snapshotNativeSession(session);
    expect(snapshot.state.isStreaming).toBe(true);
    expect(snapshot.streamingMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "half a reply" }],
    });
    expect(snapshot.messages.some((message) => (message as { role?: string }).role === "assistant")).toBe(
      false,
    );
    expect(snapshot.pendingToolCalls).toEqual([]);
    expect(snapshot.queue?.steering).toEqual(["queued for the next safe boundary"]);
    const text = partial.content[0];
    if (text?.type !== "text") throw new Error("scripted text is missing");
    text.text = "changed after the snapshot";
    session.clearQueue();
    expect(snapshot.streamingMessage).toMatchObject({ content: [{ text: "half a reply" }] });
    expect(snapshot.queue?.steering).toHaveLength(1);
    release();
    await running;
  } finally {
    release();
    await running;
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
