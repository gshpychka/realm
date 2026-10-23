import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { emptySession, reduce, restore } from "@pituitary/session";
import { serveConversationFixture } from "./conversation.fixture.ts";
import { type ConversationIdentity, type ConversationUpdate, connectConversation } from "./conversation.ts";
import { openConversation } from "./conversation-bridge.ts";

const context = BACKGROUND_CONTEXT;
const identity: ConversationIdentity = {
  runId: "run-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  cwd: "/work/workspace",
  local: false,
  archived: false,
  role: "builder",
};
test("native committed events and atomic snapshots agree through tools and duplicate input admission", async () => {
  const root = mkdtempSync("/tmp/pituitary-conversation-");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test",
      tools: [
        defineTool({
          name: "echo",
          parameters: Type.Object({ value: Type.String() }),
          description: "Echo the input",
          replay: "safe",
          execute: async (args) => ({ output: [{ type: "text", text: args.value }] }),
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(root, "native.sqlite")),
    { models, registry },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  let rendered = emptySession;
  const records: ConversationUpdate[] = [];
  const bridge = await openConversation({
    harness,
    conversation,
    models,
    identity,
    control: true,
    onRecord: (record) => {
      records.push(record);
      if (record.type === "event") rendered = reduce(rendered, record.event);
      else if (record.type === "snapshot")
        rendered = restore(record.snapshot.messages, rendered, record.snapshot);
    },
  });
  try {
    const first = await bridge.snapshot();
    rendered = restore(first.messages, undefined, first);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { value: "Retained tool output" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The work is complete."),
    ]);
    await bridge.call({ type: "prompt", id: "input-1", message: "Build the change" });
    await Promise.all([
      conversation.waitForIdle(context),
      ...Array.from({ length: 10 }, () => bridge.call({ type: "get_session_stats" })),
    ]);
    const deadline = Date.now() + 2000;
    while (!records.some((record) => record.type === "event" && record.event.type === "agent_settled")) {
      if (Date.now() > deadline) throw new Error("Native run_end was not projected");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const snapshot = await bridge.snapshot();
    expect(JSON.stringify(snapshot.messages)).toContain("Retained tool output");
    expect(JSON.stringify(rendered.entries)).toContain("The work is complete.");
    expect(JSON.stringify(rendered.entries)).toContain("Retained tool output");
    const calls = faux.state.callCount;
    await bridge.call({ type: "prompt", id: "input-1", message: "Build the change" });
    await conversation.waitForIdle(context);
    expect(faux.state.callCount).toBe(calls);
    expect((await bridge.snapshot()).messages).toEqual(snapshot.messages);
    expect(records.some((record) => record.type === "event" && record.event.type === "agent_settled")).toBe(
      true,
    );
    await bridge.call({ type: "set_session_name", name: "Menu implementation" });
    expect((await bridge.snapshot()).state.sessionName).toBe("Menu implementation");
  } finally {
    await bridge.close();
    await harness.close(context);
    rmSync(root, { recursive: true, force: true });
  }
});

test("detaching a projection preserves native work and archived observers cannot mutate it", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let finish: (value: ReturnType<typeof fauxAssistantMessage>) => void = () => {};
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  faux.setResponses([
    () => {
      requested();
      return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
        finish = resolve;
      });
    },
  ]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const first = await openConversation({
    harness,
    conversation,
    models,
    identity,
    control: true,
    onRecord: () => {},
  });
  try {
    await first.call({ type: "prompt", message: "Continue while the frontend is closed", id: "long-input" });
    await started;
    await first.close();
    finish(fauxAssistantMessage("The host kept the run alive."));
    await conversation.waitForIdle(context);
    const observer = await openConversation({
      harness,
      conversation,
      models,
      identity: { ...identity, archived: true },
      control: false,
      onRecord: () => {},
    });
    try {
      const snapshot = await observer.snapshot();
      expect(JSON.stringify(snapshot.messages)).toContain("The host kept the run alive.");
      expect(snapshot.state.isStreaming).toBe(false);
      await expect(observer.call({ type: "prompt", message: "Should be refused" })).rejects.toThrow(
        "archived",
      );
      await expect(observer.call({ type: "set_session_name", name: "Changed" })).rejects.toThrow("archived");
    } finally {
      await observer.close();
    }
  } finally {
    await first.close();
    finish(fauxAssistantMessage("Finished"));
    await harness.close(context);
  }
});

test("Unix conversation clients reconnect to native history and keep observer authority explicit", async () => {
  const root = mkdtempSync("/tmp/pituitary-conversation-client-");
  const fixture = await serveConversationFixture(root, [
    {
      id: "coordinator",
      currentAttemptId: "attempt-1",
      objective: "Keep the conversation",
      role: "coordinator",
    },
  ]);
  const options = { socketPath: fixture.socketPath, runId: "run-team", taskId: "coordinator", control: true };
  const owner = await connectConversation(options);
  let observer: Awaited<ReturnType<typeof connectConversation>> | undefined;
  try {
    expect(owner.controlsInput).toBe(true);
    expect(owner.identity.cwd).toBe("/work/workspace");
    await owner.call({ type: "set_session_name", name: "Durable conversation" });
    await owner.close();
    observer = await connectConversation({ ...options, control: false });
    expect(observer.controlsInput).toBe(false);
    expect((await observer.getState()).sessionName).toBe("Durable conversation");
    expect(JSON.stringify((await observer.getSnapshot()).messages)).toContain(
      "I delegated keyboard behavior",
    );
    await expect(observer.call({ type: "set_session_name", name: "Forbidden" })).rejects.toThrow("Join");
  } finally {
    await owner.close();
    await observer?.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native local model selection uses configured models while declared roles stay pinned", async () => {
  const faux = fauxProvider({ models: [{ id: "first", reasoning: true }, { id: "second" }] });
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    getModels: () =>
      faux.provider.getModels().map((model) => ({
        ...model,
        thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
      })),
  });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: {} });
  const local = await openConversation({
    harness,
    conversation,
    models,
    identity: { ...identity, local: true, role: undefined },
    control: true,
    onRecord: () => {},
  });
  const declared = await openConversation({
    harness,
    conversation,
    models,
    identity,
    control: true,
    onRecord: () => {},
  });
  try {
    expect((await local.snapshot()).state.model).toBeUndefined();
    expect(
      ((await local.call({ type: "get_available_models" })) as { models: unknown[] }).models,
    ).toHaveLength(2);
    await local.call({ type: "set_model", provider: "faux", modelId: "second" });
    expect((await local.snapshot()).state.model?.id).toBe("second");
    expect(await local.call({ type: "cycle_thinking_level" })).toEqual({ level: "off" });
    await local.call({ type: "set_model", provider: "faux", modelId: "first" });
    expect(await local.call({ type: "cycle_thinking_level" })).toEqual({ level: "low" });
    await local.call({ type: "set_thinking_level", level: "high" });
    expect(await local.call({ type: "cycle_thinking_level" })).toEqual({ level: "xhigh" });
    expect(await local.call({ type: "cycle_thinking_level" })).toEqual({ level: "max" });
    expect(await local.call({ type: "cycle_thinking_level" })).toEqual({ level: "off" });
    await local.call({ type: "set_model", provider: "faux", modelId: "second" });
    await expect(declared.call({ type: "set_model", provider: "faux", modelId: "first" })).rejects.toThrow(
      "declared",
    );
    await expect(local.call({ type: "set_model", provider: "missing", modelId: "secret" })).rejects.toThrow(
      "unavailable",
    );
    expect((await local.snapshot()).state.model?.id).toBe("second");
  } finally {
    await local.close();
    await declared.close();
    await harness.close(context);
  }
});

test("an archived partial survives a different completed assistant with the same timestamp", async () => {
  const faux = fauxProvider({ tokensPerSecond: 500 });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  await conversation.submit(
    {
      type: "write",
      entry: { kind: "pi.assistant", model: [fauxAssistantMessage("An older reply", { timestamp: 42 })] },
    },
    context,
  );
  faux.setResponses([fauxAssistantMessage("Interrupted native progress. ".repeat(100), { timestamp: 42 })]);
  const active = await openConversation({
    harness,
    conversation,
    models,
    identity,
    control: true,
    onRecord: () => {},
  });
  let archive: Awaited<ReturnType<typeof openConversation>> | undefined;
  try {
    await active.call({ type: "prompt", message: "Continue" });
    const deadline = Date.now() + 3000;
    for (;;) {
      const snapshot = await active.snapshot();
      if (String(JSON.stringify(snapshot.streamingMessage)).includes("Interrupted")) break;
      if (Date.now() > deadline) throw new Error("Native partial did not stream");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    archive = await openConversation({
      harness,
      conversation,
      models,
      identity: { ...identity, archived: true },
      control: false,
      onRecord: () => {},
    });
    const snapshot = await archive.snapshot();
    expect(JSON.stringify(snapshot.messages)).toContain("An older reply");
    expect(JSON.stringify(snapshot.messages)).toContain("Interrupted");
    expect(snapshot.state.isStreaming).toBe(false);
    expect(snapshot.streamingMessage).toBeUndefined();
  } finally {
    await archive?.close();
    await active.close();
    await conversation.abort(context);
    await harness.close(context);
  }
});
