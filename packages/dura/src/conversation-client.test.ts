import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { SessionSnapshot } from "@pituitary/session";
import { ConversationClient, connectConversation } from "./conversation.ts";

test("conversation attachment closure settles readiness, preserves empty reasons and scrubs refusals", async () => {
  const root = await mkdtemp("/tmp/dura-client-"),
    socketPath = join(root, "runtime.sock");
  let mode: "pending" | "closed" | "refused" = "pending",
    commands = 0;
  const snapshot: SessionSnapshot = {
    sequence: 0,
    state: {
      sessionId: "conversation",
      thinkingLevel: "off",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "all",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    },
    messages: [],
    pendingToolCalls: [],
  };
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      commands++;
      res.end("null");
      return;
    }
    if (mode === "refused") {
      res.writeHead(403).end(JSON.stringify({ error: "unsafe\x1b[2J refusal" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.flushHeaders();
    if (mode === "closed")
      res.end(
        `${JSON.stringify({
          type: "welcome",
          id: "attachment",
          identity: {
            runId: "run",
            taskId: "task",
            attemptId: "attempt",
            cwd: "/work",
            local: true,
            archived: false,
          },
          control: true,
          capabilities: [],
          snapshot,
        })}\n${JSON.stringify({ type: "closed", reason: "" })}\n`,
      );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const options = { socketPath, runId: "run", taskId: "task", control: true, timeout: 15_000 };
  try {
    const early = new ConversationClient(options);
    const waiting = [early.connected(), early.getSnapshot(), early.getState()];
    await early.close();
    const settled = await Promise.race([
      Promise.allSettled(waiting),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Early close did not settle readiness")), 200).unref(),
      ),
    ]);
    expect(settled.every((value) => value.status === "rejected")).toBe(true);
    mode = "closed";
    const closed = new ConversationClient(options),
      reasons: string[] = [];
    closed.onClose((reason) => reasons.push(reason));
    await closed.connected();
    await new Promise((resolve) => setTimeout(resolve, 10));
    closed.onClose((reason) => reasons.push(reason));
    expect(reasons).toEqual(["", ""]);
    expect(closed.controlsInput).toBe(false);
    await expect(closed.getState()).rejects.toThrow();
    expect(commands).toBe(0);
    mode = "refused";
    await expect(connectConversation(options)).rejects.toThrow("unsafe refusal");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
