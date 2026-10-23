import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  defineDoc,
  type EntryRecord,
  type Harness,
  InboxDoc,
  type SnapshotEvent,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { SessionEvent, SessionSnapshot, SessionState, SessionStats } from "@pituitary/session";
import type { ConversationCommand, ConversationIdentity, ConversationUpdate } from "./conversation.ts";

const context = BACKGROUND_CONTEXT;
const Presentation = defineDoc<{ name: string }>({
  kind: "pituitary.presentation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ name: "" }),
  checkpointWhen: () => true,
});
const READ = new Set([
  "get_snapshot",
  "get_state",
  "get_messages",
  "get_session_stats",
  "get_available_models",
  "get_available_thinking_levels",
  "get_last_assistant_text",
]);
export const CONVERSATION_CAPABILITIES = [
  "atomic-snapshot",
  "messages",
  "abort",
  "compact",
  "name",
  "thinking",
];

export interface ConversationBridge {
  snapshot(): Promise<SessionSnapshot>;
  call(command: ConversationCommand): Promise<unknown>;
  close(): Promise<void>;
}
export interface OpenConversationOptions {
  harness: Harness;
  conversation: Conversation;
  models: Models;
  identity: ConversationIdentity;
  control: boolean;
  onRecord(record: ConversationUpdate): void;
}

/** Translate the upstream committed event stream once, at the frontend boundary. */
export async function openConversation(options: OpenConversationOptions): Promise<ConversationBridge> {
  const { harness, conversation, models, identity, onRecord } = options;
  let stream: AgentEventStream | undefined;
  let sequence = 0;
  let generation = 0;
  let closed = false;
  let refreshing: Promise<SessionSnapshot> | undefined;
  const toolOutput = new Map<string, string>();
  const publish = (event: unknown) =>
    onRecord({ type: "event", sequence: ++sequence, event: event as SessionEvent });
  const text = (message: unknown): string => {
    if (!message || typeof message !== "object" || !("content" in message)) return "";
    const content = message.content;
    return typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block?.type === "text" ? String(block.text) : "")).join("")
        : "";
  };
  const shown = (entry: EntryRecord): unknown[] => {
    if (entry.kind === "pi.system" || entry.kind === "pi.reset") return [];
    if (entry.kind === "pi.compaction")
      return [
        { role: "compactionSummary", summary: text(entry.model?.[0]), entryId: entry.id, timestamp: 0 },
      ];
    if (!entry.kind.startsWith("pi.") && entry.model?.length)
      return [
        {
          role: "custom",
          entryId: entry.id,
          customType: entry.kind.replace(/^pituitary\./, ""),
          content: entry.model.map(text).join("\n"),
          details: entry.data,
          timestamp: 0,
        },
      ];
    return (entry.model ?? []).map((message, index) => ({ ...message, entryId: `${entry.id}:${index}` }));
  };
  const state = (snapshot: SnapshotEvent, name: string): SessionState => ({
    sessionId: String(conversation.id),
    sessionName: name || undefined,
    model: snapshot.agent.model
      ? (models.getModel(
          snapshot.agent.model.provider,
          snapshot.agent.model.modelId,
        ) as SessionState["model"])
      : undefined,
    thinkingLevel: (snapshot.agent.thinkingLevel ?? "off") as SessionState["thinkingLevel"],
    isStreaming: !identity.archived && Boolean(snapshot.run),
    isCompacting: !identity.archived && snapshot.compactions.length > 0,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messageCount: snapshot.entries.flatMap(shown).length,
    pendingMessageCount: identity.archived ? 0 : snapshot.inbox.length,
  });
  const projected = async (snapshot: SnapshotEvent): Promise<SessionSnapshot> => {
    const metadata = await harness.snapshot(Presentation, conversation.id, context);
    const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
    const queue = { steering: [] as string[], followUp: [] as string[] };
    for (const item of inbox?.items ?? []) {
      if (item.mode !== "write" && snapshot.inbox.some((known) => known.id === item.id))
        queue[item.mode === "steer" ? "steering" : "followUp"].push(
          typeof item.content === "string" ? item.content : text({ content: item.content }),
        );
    }
    const messages = snapshot.entries.flatMap(shown);
    const partial = snapshot.generation?.message;
    if (
      identity.archived &&
      partial &&
      !messages.some(
        (message) =>
          message &&
          typeof message === "object" &&
          "role" in message &&
          message.role === "assistant" &&
          "timestamp" in message &&
          message.timestamp === partial.timestamp &&
          "content" in message &&
          JSON.stringify(message.content) === JSON.stringify(partial.content),
      )
    )
      messages.push({ ...partial, stopReason: "aborted" });
    return {
      sequence,
      state: { ...state(snapshot, metadata?.name ?? ""), messageCount: messages.length },
      messages,
      streamingMessage: identity.archived ? undefined : partial,
      pendingToolCalls: identity.archived
        ? []
        : snapshot.tools.filter((tool) => tool.status !== "done").map((tool) => tool.callId),
      queue: identity.archived ? { steering: [], followUp: [] } : queue,
    };
  };
  const translate = async (event: AgentEvent) => {
    switch (event.type) {
      case "snapshot":
        onRecord({ type: "snapshot", snapshot: { ...(await projected(event)), sequence: ++sequence } });
        return;
      case "run_start":
        publish({ type: "agent_start" });
        return;
      case "run_end":
        publish({ type: "agent_end", messages: [] });
        publish({ type: "agent_settled" });
        return;
      case "turn_start":
        publish({ type: "turn_start" });
        return;
      case "turn_end":
        return;
      case "message_start":
        if (event.message.role !== "assistant") return;
        publish({ type: "message_start", message: event.message });
        for (const [contentIndex, block] of event.message.content.entries()) {
          if (block.type === "text" || block.type === "thinking") {
            publish({
              type: "message_update",
              usage: event.message.usage,
              assistantMessageEvent: { type: `${block.type}_start`, contentIndex },
            });
            publish({
              type: "message_update",
              usage: event.message.usage,
              assistantMessageEvent: {
                type: `${block.type}_delta`,
                contentIndex,
                delta: block.type === "text" ? block.text : block.thinking,
              },
            });
          } else if (block.type === "toolCall") {
            publish({
              type: "message_update",
              usage: event.message.usage,
              assistantMessageEvent: {
                type: "toolcall_start",
                contentIndex,
                id: block.id,
                toolName: block.name,
              },
            });
            publish({
              type: "message_update",
              usage: event.message.usage,
              assistantMessageEvent: {
                type: "toolcall_delta",
                contentIndex,
                delta: JSON.stringify(block.arguments),
              },
            });
          }
        }
        return;
      case "message_end":
        for (const message of shown(event.entry)) {
          if (message && typeof message === "object" && "role" in message && message.role !== "assistant")
            publish({ type: "message_start", message });
          publish({ type: "message_end", message });
        }
        return;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "message" || change.type === "block") {
            // Full replacements are rare (provider correction or retained-stream overflow).
            // Reattach to upstream's atomic view instead of guessing how to patch a draft.
            publish({ type: "session_info_changed" });
            return;
          }
          if (change.type === "toolcall_delta" && change.path.length) {
            publish({ type: "session_info_changed" });
            return;
          }
          if (change.type === "toolcall_start")
            publish({
              type: "message_update",
              usage: event.usage,
              assistantMessageEvent: {
                type: "toolcall_start",
                contentIndex: change.contentIndex,
                id: change.block.type === "toolCall" ? change.block.id : "",
                toolName: change.block.type === "toolCall" ? change.block.name : "",
              },
            });
          else {
            publish({ type: "message_update", usage: event.usage, assistantMessageEvent: change });
            if (change.type === "text_start" && change.block.type === "text" && change.block.text)
              publish({
                type: "message_update",
                usage: event.usage,
                assistantMessageEvent: {
                  type: "text_delta",
                  contentIndex: change.contentIndex,
                  delta: change.block.text,
                },
              });
            if (change.type === "thinking_start" && change.block.type === "thinking" && change.block.thinking)
              publish({
                type: "message_update",
                usage: event.usage,
                assistantMessageEvent: {
                  type: "thinking_delta",
                  contentIndex: change.contentIndex,
                  delta: change.block.thinking,
                },
              });
          }
        }
        return;
      case "tool_execution_start":
        toolOutput.set(event.toolCallId, "");
        publish(event);
        return;
      case "tool_execution_update": {
        const previous = toolOutput.get(event.toolCallId) ?? "";
        const output =
          event.output && "set" in event.output
            ? event.output.set
            : previous.slice(event.output?.trimStart ?? 0) + (event.output?.append ?? "");
        toolOutput.set(event.toolCallId, output);
        publish({
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partialResult: { content: [{ type: "text", text: output }], details: event.details },
        });
        return;
      }
      case "tool_execution_end": {
        const message = event.entry?.model?.[0];
        publish({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result:
            message?.role === "toolResult"
              ? { content: message.content, details: event.entry?.data }
              : (event.result ?? {
                  content: [{ type: "text", text: toolOutput.get(event.toolCallId) ?? "" }],
                }),
          isError: message?.role === "toolResult" ? message.isError : (event.result?.isError ?? true),
        });
        toolOutput.delete(event.toolCallId);
        return;
      }
      case "inbox_update":
        publish({ type: "session_info_changed" });
        return;
      case "agent_changed":
      case "usage_changed":
        publish({ type: "session_info_changed" });
        return;
      case "auto_retry_start":
        publish({
          type: "auto_retry_start",
          attempt: event.attempt,
          delayMs: Math.max(0, event.at - Date.now()),
          errorMessage: event.errorMessage,
        });
        return;
      case "auto_retry_end":
        publish({ type: "auto_retry_end", success: true, attempt: event.attempt });
        return;
      case "compaction_start":
        publish({ type: "compaction_start", reason: event.reason });
        return;
      case "compaction_end":
        publish({ type: "compaction_end", aborted: false, errorMessage: event.error });
        return;
      case "task_failed":
        publish({
          type: "runtime_error",
          source: "conversation",
          event: event.kind,
          error: event.message,
        });
        return;
      case "entry_appended":
      case "submission":
      case "deferred_poll":
        return;
    }
  };
  function refresh(): Promise<SessionSnapshot> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const ticket = ++generation;
      await stream?.stop();
      if (closed) throw new Error("Conversation attachment closed");
      const next = await watchEvents(harness, conversation.id, context);
      stream = next;
      toolOutput.clear();
      for (const tool of next.snapshot.tools) toolOutput.set(tool.callId, tool.output ?? "");
      const snapshot = await projected(next.snapshot);
      next.start(async (events) => {
        for (const event of events) {
          if (ticket !== generation || closed) return;
          await translate(event);
        }
      });
      return snapshot;
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }
  let initial: SessionSnapshot | undefined = await refresh();
  const snapshot = async () => {
    if (initial) {
      const value = initial;
      initial = undefined;
      return value;
    }
    return refresh();
  };
  // Metadata reads never replace the active stream: only get_snapshot advances the UI's cursor.
  const read = async () => {
    const observed = await watchEvents(harness, conversation.id, context);
    try {
      return await projected(observed.snapshot);
    } finally {
      await observed.stop();
    }
  };
  const command = async (command: ConversationCommand): Promise<unknown> => {
    if (closed) throw new Error("Conversation attachment closed");
    if (!READ.has(command.type) && (identity.archived || !options.control))
      throw new Error(
        identity.archived ? "This conversation is archived and read only" : "Join this conversation to write",
      );
    if (command.type === "get_snapshot") return snapshot();
    if (command.type === "get_state") return (await read()).state;
    if (command.type === "get_messages") return { messages: (await read()).messages };
    if (command.type === "get_available_models") return { models: await models.getAvailable() };
    if (command.type === "get_available_thinking_levels") {
      const current = await conversation.agent(context);
      const model = current.model
        ? models.getModel(current.model.provider, current.model.modelId)
        : undefined;
      return { levels: model ? getSupportedThinkingLevels(model) : ["off"] };
    }
    if (command.type === "get_last_assistant_text")
      return {
        text:
          (await read()).messages
            .filter((message) =>
              Boolean(
                message && typeof message === "object" && "role" in message && message.role === "assistant",
              ),
            )
            .map(text)
            .at(-1) ?? null,
      };
    if (command.type === "get_session_stats") {
      const current = await read();
      const usage = await harness.snapshot(UsageDoc, conversation.id, context);
      const stats: SessionStats = {
        sessionId: String(conversation.id),
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: current.messages.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      };
      for (const message of current.messages) {
        if (!message || typeof message !== "object" || !("role" in message)) continue;
        if (message.role === "user") stats.userMessages++;
        if (message.role === "assistant") stats.assistantMessages++;
        if (message.role === "toolResult") stats.toolResults++;
        if ("content" in message && Array.isArray(message.content))
          stats.toolCalls += message.content.filter((block) => block?.type === "toolCall").length;
      }
      for (const value of [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})]) {
        stats.tokens.input += value.input;
        stats.tokens.output += value.output;
        stats.tokens.cacheRead += value.cacheRead;
        stats.tokens.cacheWrite += value.cacheWrite;
        stats.tokens.total += value.totalTokens;
        stats.cost += value.cost.total;
      }
      const last = current.messages.findLast(
        (message) =>
          message && typeof message === "object" && "role" in message && message.role === "assistant",
      ) as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } } | undefined;
      const window = current.state.model?.contextWindow;
      if (last?.usage && window)
        stats.contextUsage = {
          percent:
            (100 * (last.usage.input + last.usage.output + last.usage.cacheRead + last.usage.cacheWrite)) /
            window,
        };
      return stats;
    }
    if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
      await conversation.submit(
        {
          type: "input",
          requestId: command.id ?? randomUUID(),
          content: command.images?.length
            ? [{ type: "text", text: command.message }, ...command.images]
            : command.message,
          whenBusy:
            command.type === "follow_up"
              ? "followUp"
              : command.type === "steer"
                ? "steer"
                : (command.streamingBehavior ?? "reject"),
        },
        context,
      );
      return;
    }
    if (command.type === "abort" || command.type === "abort_retry") return conversation.abort(context);
    if (command.type === "compact")
      return { taskId: await conversation.compact(command.customInstructions, context) };
    if (command.type === "set_session_name") {
      await conversation.commit(async (tx) => {
        (await tx.doc(Presentation, conversation.id)).name = command.name;
      }, context);
      publish({ type: "session_info_changed" });
      return;
    }
    if (command.type === "set_thinking_level")
      return conversation.configure({ thinkingLevel: command.level }, context);
    if (command.type === "cycle_thinking_level") {
      const levels = ["off", "minimal", "low", "medium", "high"] as const;
      const current = await conversation.agent(context);
      const level =
        levels[(levels.indexOf(current.thinkingLevel as (typeof levels)[number]) + 1) % levels.length] ??
        "off";
      await conversation.configure({ thinkingLevel: level }, context);
      return { level };
    }
    if (command.type === "clear_queue") {
      const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
      const result = { steering: [] as string[], followUp: [] as string[] };
      for (const item of inbox?.items ?? []) {
        if (item.mode === "write") continue;
        const status = await harness.abortSubmission(item.id, context, conversation.id);
        if (status === "aborted")
          result[item.mode === "steer" ? "steering" : "followUp"].push(
            typeof item.content === "string" ? item.content : text({ content: item.content }),
          );
      }
      return result;
    }
    if (command.type === "set_model" || command.type === "cycle_model") {
      if (!identity.local || identity.role)
        throw new Error("The model is declared by this agent's role. Start a new run to change it.");
      const available = await models.getAvailable();
      const current = await conversation.agent(context);
      const next =
        command.type === "set_model"
          ? available.find((model) => model.provider === command.provider && model.id === command.modelId)
          : available[
              (available.findIndex(
                (model) => model.provider === current.model?.provider && model.id === current.model.modelId,
              ) +
                1) %
                available.length
            ];
      if (!next) throw new Error("This model is unavailable; configure its provider credential first.");
      if (command.type === "cycle_model" && available.length < 2) return null;
      await conversation.configure({ model: { provider: next.provider, modelId: next.id } }, context);
      return command.type === "set_model" ? next : { model: next };
    }
    throw new Error(`This managed conversation does not support ${command.type}`);
  };
  return {
    snapshot,
    call: command,
    close: async () => {
      if (closed) return;
      closed = true;
      generation++;
      await stream?.stop();
    },
  };
}
