import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type { ConversationLink, SessionEvent } from "@pituitary/session";
import { connectConversation } from "@realm/dura/client";
import { serveConversationFixture } from "../../../../dura/src/conversation.fixture.ts";
import { type SessionController, useSession } from "./use-session.ts";

async function until(done: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Native session did not update");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test("native atomic snapshots and paced events retain each reply once", async () => {
  const directory = mkdtempSync("/tmp/pituitary-session-view-");
  const host = await serveConversationFixture(
    directory,
    [{ id: "solo", currentAttemptId: "one", objective: "", role: null }],
    { local: true, scenario: "hello" },
  );
  const client = await connectConversation({
    socketPath: host.socketPath,
    runId: "run-team",
    taskId: "solo",
    control: true,
  });
  const app = await createTestRenderer({ width: 40, height: 8 }),
    root = createRoot(app.renderer);
  let session!: SessionController;
  function Probe() {
    session = useSession(client);
    return null;
  }
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => session.state !== null);
    expect(await session.send("first native reply")).toBe(true);
    await until(
      () =>
        !session.view.running &&
        session.view.entries.some(
          (entry) => entry.kind === "assistant" && entry.text === "You said: first native reply",
        ),
    );
    await session.refresh();
    expect(session.view.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(session.view.entries.find((entry) => entry.kind === "user")).toMatchObject({
      text: "first native reply",
    });
    await client.close();
    await until(() => session.closed !== null);
    expect(session.view.running).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
    await client.close();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a link moving to another session starts the view afresh, keeping what is noted from then on", async () => {
  const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
  let messages: unknown[] = [user("from the old session", 1)];
  const replaced = new Set<() => void>();
  const state = { sessionId: "s", thinkingLevel: "off", isStreaming: false, isCompacting: false };
  const link = {
    onEvent: () => () => {},
    onClose: () => () => {},
    onReplace(listener: () => void) {
      replaced.add(listener);
      return () => replaced.delete(listener);
    },
    getSnapshot: async () => ({ sequence: 0, state, messages, pendingToolCalls: [] }),
    getSessionStats: () => new Promise(() => {}),
  } as unknown as ConversationLink;
  const app = await createTestRenderer({ width: 40, height: 8 }),
    root = createRoot(app.renderer);
  let session!: SessionController;
  function Probe() {
    session = useSession(link);
    return null;
  }
  const texts = () => session.view.entries.map((entry) => ("text" in entry ? entry.text : entry.kind));
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => texts().includes("from the old session"));
    session.notify("info", "noted in the old session");
    messages = [user("from the new session", 2)];
    for (const listener of replaced) listener();
    session.notify("info", "Forked into a new session");
    await until(() => texts().includes("from the new session"));
    expect(texts()).toEqual(["from the new session", "Forked into a new session"]);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("a shell command is read back from the session once Pi records it as it ends, or once the run it ended in does", async () => {
  let messages: unknown[] = [];
  let snapshots = 0;
  let emit: (event: SessionEvent, sequence: number) => void = () => {};
  const state = { sessionId: "s", thinkingLevel: "off", isStreaming: false, isCompacting: false };
  const link = {
    onEvent(listener: typeof emit) {
      emit = listener;
      return () => {};
    },
    onClose: () => () => {},
    getSnapshot: async () => {
      snapshots++;
      return { sequence: 0, state, messages, pendingToolCalls: [] };
    },
    getSessionStats: () => new Promise(() => {}),
  } as unknown as ConversationLink;
  const app = await createTestRenderer({ width: 40, height: 8 }),
    root = createRoot(app.renderer);
  let session!: SessionController;
  function Probe() {
    session = useSession(link);
    return null;
  }
  let sequence = 0;
  const send = (event: SessionEvent) => emit(event, ++sequence);
  const result = { output: "a.txt\n", exitCode: 0, cancelled: false, truncated: false };
  const shells = () => session.view.entries.filter((entry) => entry.kind === "bash");
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => snapshots === 1);
    send({ type: "bash_start", id: "r1", command: "ls", excludeFromContext: false });
    send({ type: "bash_execution_update", id: "r1", delta: "a.txt\n" });
    await until(() => shells()[0]?.output === "a.txt\n");
    expect(shells()[0]).toMatchObject({ running: "r1" });
    // Pi has recorded the command by the time it answers.
    messages = [{ role: "bashExecution", command: "ls", ...result, timestamp: 5 }];
    send({ type: "bash_end", id: "r1", result });
    await until(() => snapshots === 2);
    await until(() => session.view.messages === 1);
    expect(shells()).toHaveLength(1);
    expect(shells()[0]).not.toHaveProperty("running");

    // Under a run, Pi records it only once the run ends, which reads the session again anyway.
    send({ type: "agent_start" });
    send({ type: "bash_start", id: "r2", command: "pwd", excludeFromContext: true });
    send({ type: "bash_end", id: "r2", result });
    await until(() => shells().length === 2 && shells()[1]?.running === undefined);
    expect(snapshots).toBe(2);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
