import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSessionState, type RpcCommand, restore, type SessionStats } from "@pituitary/rpc";
import { archiveWorker, projectArchive, projectWorker, readArchive } from "./projection.ts";
import { startWorker } from "./worker.ts";
import { connectWorker } from "./worker-client.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pituitary-project-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let prompts = 0;
  const state = { ...fakeSessionState };
  const messages = [{ role: "assistant", content: [{ type: "text", text: "The saved result." }] }];
  const stats: SessionStats = {
    sessionFile: undefined,
    sessionId: state.sessionId,
    userMessages: 0,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 1,
    tokens: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, total: 5 },
    cost: 0,
  };
  const worker = await startWorker({
    socketPath: join(root, "native.sock"),
    stateDirectory: root,
    cwd: root,
    engineFactory: async () => ({
      call: async (command: RpcCommand) => {
        if (command.type === "get_state") return { ...state };
        if (command.type === "get_session_stats") return stats;
        if (command.type === "prompt") {
          prompts++;
          return;
        }
        throw new Error("Unexpected command " + command.type);
      },
      snapshot: () => ({ state: { ...state }, messages, pendingToolCalls: [] }),
      respond: () => {},
      close: async () => {},
    }),
  });
  cleanup.push(() => worker.close());
  const source = await connectWorker(worker.socketPath);
  cleanup.push(() => source.close());
  return {
    root,
    worker,
    source,
    stats,
    get prompts() {
      return prompts;
    },
  };
}

test("an attached frontend loses write authority immediately when its attempt stops accepting input", async () => {
  const value = await fixture();
  let writable = true;
  const projection = await projectWorker(join(value.root, "view.sock"), value.source, {
    canWrite: () => writable,
  });
  cleanup.push(() => projection.close());
  const frontend = await connectWorker(join(value.root, "view.sock"));
  cleanup.push(() => frontend.close());
  await frontend.prompt("Allowed");
  expect(value.prompts).toBe(1);
  writable = false;
  await expect(frontend.prompt("Too late")).rejects.toThrow("cannot change this attempt");
  expect(value.prompts).toBe(1);
  expect((await frontend.getState()).sessionId).toBe(fakeSessionState.sessionId);
});

test("a private durable archive serves the same conversation after its worker is gone", async () => {
  const value = await fixture();
  const archive = await archiveWorker(value.root, value.source);
  expect(statSync(join(value.root, "conversation.json")).mode & 0o777).toBe(0o600);
  expect(readArchive(value.root)).toEqual(archive);
  await value.source.close();
  await value.worker.close();
  const path = join(value.root, "archive.sock"),
    projection = await projectArchive(path, archive);
  cleanup.push(() => projection.close());
  const frontend = await connectWorker(path);
  cleanup.push(() => frontend.close());
  expect(frontend.identity.archived).toBe(true);
  expect((await frontend.getSnapshot?.())?.messages).toEqual(archive.snapshot.messages);
  expect(await frontend.getSessionStats()).toEqual(value.stats);
  expect(await frontend.call({ type: "get_last_assistant_text" })).toEqual({ text: "The saved result." });
  await expect(frontend.prompt("Wake up")).rejects.toThrow("archived and read-only");
});

test.each([false, true])(
  "an archived partial reply remains inspectable without repeating finalized history (%s)",
  async (finalized) => {
    const value = await fixture();
    const archive = await archiveWorker(value.root, value.source);
    const partial = {
      role: "assistant",
      timestamp: 123,
      content: [
        { type: "text", text: "An unfinished reply." },
        { type: "toolCall", id: "pending", name: "read", arguments: { path: "README.md" } },
      ],
    };
    archive.snapshot.state.isStreaming = true;
    archive.snapshot.streamingMessage = partial;
    archive.snapshot.pendingToolCalls = ["pending"];
    if (finalized) archive.snapshot.messages = [...archive.snapshot.messages, partial];
    const projection = await projectArchive(join(value.root, "partial.sock"), archive);
    cleanup.push(() => projection.close());
    const frontend = await connectWorker(join(value.root, "partial.sock"));
    cleanup.push(() => frontend.close());
    const snapshot = await frontend.getSnapshot?.();
    if (!snapshot) throw new Error("The archived projection did not expose an atomic snapshot");
    const view = restore(snapshot.messages, undefined, snapshot);
    const replies = view.entries.filter(
      (entry) => entry.kind === "assistant" && entry.text === "An unfinished reply.",
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      done: true,
      tools: [{ id: "pending", state: "error", output: "interrupted" }],
    });
    expect(view.running).toBe(false);
    expect(snapshot.streamingMessage).toBeUndefined();
    expect(archive.snapshot.streamingMessage).toEqual(partial);
  },
);
