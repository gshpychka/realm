import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { codingExtension, codingTools } from "./coding.ts";
import type { ConversationCommand, ConversationRecord } from "./conversation.ts";
import {
  CONVERSATION_CAPABILITIES,
  type ConversationBridge,
  openConversation,
} from "./conversation-bridge.ts";

/** A real native conversation stream, without a provider, for terminal fixtures. */
export async function serveConversationFixture(
  directory: string,
  tasks: readonly { id: string; currentAttemptId: string; objective: string; role: string | null }[],
  options: {
    local?: boolean;
    cwd?: string;
    scenario?: string;
    delayMs?: number;
    archived?: boolean;
    archiveTasks?: readonly string[];
    model?: boolean;
  } = {},
) {
  const nativeContext = BACKGROUND_CONTEXT;
  const scenario = options.scenario ?? "team";
  const faux = fauxProvider({
    models: [
      { id: "faux-1", name: "Faux Model", reasoning: true },
      { id: "faux-2", name: "Faux Fast" },
    ],
    ...(options.delayMs ? { tokensPerSecond: 4000 / options.delayMs } : {}),
  });
  faux.setResponses(
    Array.from({ length: 200 }, () => async (transcript: TranscriptContext) => {
      const last = transcript.messages.at(-1);
      if (last?.role === "toolResult") return fauxAssistantMessage("The workspace inspection is complete.");
      if (scenario === "tool")
        return fauxAssistantMessage(
          fauxToolCall("bash", { command: "printf 'native tool output\\nline two\\n'" }),
          { stopReason: "toolUse" },
        );
      if (scenario === "long")
        return fauxAssistantMessage(
          Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the long answer`).join("\n\n"),
        );
      const user = [...transcript.messages].reverse().find((message) => message.role === "user");
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
      return fauxAssistantMessage(
        scenario === "thinking"
          ? [fauxThinking("I will reason through the request."), { type: "text", text: `You said: ${text}` }]
          : `You said: ${text}`,
      );
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(codingExtension);
  const environment = new NodeExecutionEnv({ cwd: options.cwd ?? directory });
  const native = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: () => environment },
    nativeContext,
  );
  const conversations = await Promise.all(
    tasks.map(async (item) => {
      const conversation = await native.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            ...(options.model === false ? {} : { model: { provider: "faux", modelId: "faux-1" } }),
            thinkingLevel: "medium",
            cwd: options.cwd ?? "/work/workspace",
            tools: codingTools,
          },
        },
        nativeContext,
      );
      if (scenario === "team") {
        await conversation.submit(
          {
            type: "write",
            entry: { kind: "pi.user", model: [{ role: "user", content: item.objective, timestamp: 0 }] },
          },
          nativeContext,
        );
        await conversation.submit(
          {
            type: "write",
            entry: {
              kind: "pi.assistant",
              model: [
                fauxAssistantMessage(
                  item.id === "coordinator"
                    ? "I delegated keyboard behavior to the builder and asked for an independent review."
                    : item.id === "builder"
                      ? "The menu works. I need your decision about returning focus."
                      : "The implementation and independent checks are complete.",
                ),
              ],
            },
          },
          nativeContext,
        );
      }
      if (scenario === "sprawl")
        for (let index = 0; index < 300; index++)
          await conversation.submit(
            {
              type: "write",
              entry: {
                kind: "pi.assistant",
                model: [fauxAssistantMessage(`step ${index + 1}: retained native history`)],
              },
            },
            nativeContext,
          );
      return conversation;
    }),
  );
  const attachments = new Map<string, ConversationBridge>();
  const socketPath = join(directory, "runtime.sock");
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (request.method === "GET") {
        const id = url.pathname.split("/").at(-1) ?? "";
        const index = tasks.findIndex((task) => task.id === id);
        if (index < 0) throw new Error("Unknown task");
        const task = tasks[index];
        if (!task) throw new Error("Missing native fixture task");
        const conversation = conversations[index];
        if (!conversation) throw new Error("Missing native fixture conversation");
        const attachmentId = randomUUID();
        const buffered: ConversationRecord[] = [];
        let welcomed = false;
        const identity = {
          runId: "run-team",
          taskId: id,
          attemptId: task.currentAttemptId,
          cwd: options.cwd ?? "/work/workspace",
          local: options.local ?? false,
          archived: options.archived ?? options.archiveTasks?.includes(id) ?? false,
          role: task.role ?? undefined,
        };
        const control = url.searchParams.get("control") === "1";
        const bridge = await openConversation({
          harness: native,
          conversation,
          models,
          identity,
          control,
          onRecord: (record) => {
            if (welcomed) response.write(`${JSON.stringify(record)}\n`);
            else buffered.push(record);
          },
        });
        attachments.set(attachmentId, bridge);
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.write(
          `${JSON.stringify({
            type: "welcome",
            id: attachmentId,
            identity,
            control,
            capabilities: CONVERSATION_CAPABILITIES,
            snapshot: await bridge.snapshot(),
          })}\n`,
        );
        welcomed = true;
        for (const record of buffered) response.write(`${JSON.stringify(record)}\n`);
        response.once("close", () => {
          attachments.delete(attachmentId);
          void bridge.close();
        });
        return;
      }
      const id = url.pathname.split("/").at(-2) ?? "";
      const bridge = attachments.get(id);
      if (!bridge) throw new Error("Unknown attachment");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: string;
        command: ConversationCommand;
      };
      const result = await bridge.call({ ...body.command, id: body.id } as ConversationCommand);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result ?? null));
    })().catch((error) => {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      for (const attachment of attachments.values()) await attachment.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await native.close(nativeContext);
      await environment.cleanup(nativeContext);
    },
  };
}
