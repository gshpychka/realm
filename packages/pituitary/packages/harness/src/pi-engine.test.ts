import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fakeModels, stored } from "@pituitary/rpc";
import { createNativeEngine, snapshotNativeSession } from "./pi-engine.ts";
import type { AgentManifest } from "./protocol.ts";

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
