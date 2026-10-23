import type { SessionEvent, SessionState } from "./protocol.ts";

/** The message payload carried by pi's message events. */
type AgentMessage = Extract<SessionEvent, { type: "message_start" }>["message"];

/** A streamed change to the assistant message, as it crosses the wire. */
type Delta = Extract<SessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/** Tool call arguments, which pi carries as JSON. */
export type ToolArgs = Extract<Delta, { type: "toolcall_end" }>["toolCall"]["arguments"];

const USAGE = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Presentation fixtures used by reducer and rendering tests. Native transport tests use the upstream Faux model.
 */

const MODEL: SessionState["model"] = {
  id: "fake-model-1",
  name: "Fake Model 1",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as SessionState["model"];

/** Models used by presentation fixtures, the first of them selected. */
export const fakeModels: NonNullable<SessionState["model"]>[] = [
  MODEL as NonNullable<SessionState["model"]>,
  { ...MODEL, id: "fake-model-2", name: "Fake Model 2", reasoning: false } as NonNullable<
    SessionState["model"]
  >,
];

export const fakeSessionState: SessionState = {
  model: MODEL,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  sessionId: "fake-session",
  sessionName: "fake",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

type Content = Record<string, unknown>[];

let latest = 0;

/** The time a message is made, in milliseconds since the epoch: pi stamps each message, and no two alike. */
function stamp(): number {
  latest = Math.max(Date.now(), latest + 1);
  return latest;
}

/** Usage with `output` tokens generated. */
function usage(output: number): typeof USAGE {
  return { ...USAGE, output, totalTokens: USAGE.input + output };
}

function assistantMessage(
  content: Content,
  stopReason = "stop",
  errorMessage?: string,
  spent = USAGE,
  timestamp = stamp(),
): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: MODEL?.id ?? "fake-model-1",
    usage: spent,
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp,
  } as unknown as AgentMessage;
}

function chunk(text: string, parts: number): string[] {
  if (parts <= 1 || text.length === 0) return [text];
  const size = Math.ceil(text.length / parts);
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks;
}

export function userTurn(text: string): SessionEvent[] {
  const message = { role: "user", content: text, timestamp: stamp() } as unknown as AgentMessage;
  return [
    { type: "message_start", message },
    { type: "message_end", message },
  ];
}

export interface AssistantTurnOptions {
  text?: string;
  thinking?: string;
  /** Number of deltas each block streams in. */
  parts?: number;
  toolCall?: { id: string; name: string; args: ToolArgs };
  /** Output tokens the reply generates; about four characters of streamed content each otherwise. */
  outputTokens?: number;
}

/**
 * One assistant response: optional thinking, optional text, optional tool call. It
 * streams as deltas between the message's start and its end, which carries the whole
 * message; pi forwards no delta for the stream's own start or finish. Each delta carries
 * the output tokens generated so far, in proportion to the content streamed.
 */
export function assistantTurn(options: AssistantTurnOptions): SessionEvent[] {
  const { text, thinking, parts = 3, toolCall } = options;
  const content: Content = [];
  const deltas: Delta[] = [];

  let contentIndex = 0;
  if (thinking) {
    content.push({ type: "thinking", thinking });
    deltas.push({ type: "thinking_start", contentIndex });
    for (const part of chunk(thinking, parts)) {
      deltas.push({ type: "thinking_delta", contentIndex, delta: part });
    }
    deltas.push({ type: "thinking_end", contentIndex, content: thinking });
    contentIndex++;
  }

  if (text) {
    content.push({ type: "text", text });
    deltas.push({ type: "text_start", contentIndex });
    for (const part of chunk(text, parts)) {
      deltas.push({ type: "text_delta", contentIndex, delta: part });
    }
    deltas.push({ type: "text_end", contentIndex, content: text });
    contentIndex++;
  }

  if (toolCall) {
    const call = {
      type: "toolCall" as const,
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.args,
    };
    content.push(call);
    deltas.push({ type: "toolcall_start", contentIndex, id: toolCall.id, toolName: toolCall.name });
    deltas.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.args) });
    deltas.push({ type: "toolcall_end", contentIndex, toolCall: call });
  }

  const size = (delta: Delta) => ("delta" in delta ? delta.delta.length : 0);
  const streamed = deltas.reduce((sum, delta) => sum + size(delta), 0);
  const tokens = options.outputTokens ?? Math.ceil(streamed / 4);
  let sent = 0;
  const at = stamp();
  const events: SessionEvent[] = [
    { type: "message_start", message: assistantMessage([], "stop", undefined, usage(0), at) },
  ];
  for (const delta of deltas) {
    sent += size(delta);
    events.push(update(delta, usage(streamed === 0 ? 0 : Math.round((tokens * sent) / streamed))));
  }
  const stopReason = toolCall ? "toolUse" : "stop";
  events.push({
    type: "message_end",
    message: assistantMessage(content, stopReason, undefined, usage(tokens), at),
  });
  return events;
}

/**
 * An assistant response that fails: the provider's error ends the message, with no
 * content beyond what streamed before it.
 */
export function failedTurn(errorMessage: string, stopReason: "error" | "aborted" = "error"): SessionEvent[] {
  const at = stamp();
  return [
    { type: "message_start", message: assistantMessage([], "stop", undefined, USAGE, at) },
    { type: "message_end", message: assistantMessage([], stopReason, errorMessage, USAGE, at) },
  ];
}

export interface ToolRunOptions {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Progressive output; the last entry is the final result. */
  output: string[];
  isError?: boolean;
  /** Structured result attached to the final output. */
  details?: unknown;
  /** Structured progress attached to each partial output, in order. */
  progress?: unknown[];
}

/** Execution of a tool the assistant called, followed by its result message. */
export function toolRun(options: ToolRunOptions): SessionEvent[] {
  const { id, name, args, output, isError = false, details, progress = [] } = options;
  const final = output.at(-1) ?? "";
  const events: SessionEvent[] = [{ type: "tool_execution_start", toolCallId: id, toolName: name, args }];
  output.slice(0, -1).forEach((text, index) => {
    const partial = progress[index];
    events.push({
      type: "tool_execution_update",
      toolCallId: id,
      toolName: name,
      args,
      partialResult: {
        content: [{ type: "text", text }],
        ...(partial === undefined ? {} : { details: partial }),
      },
    });
  });
  events.push({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    result: { content: [{ type: "text", text: final }], ...(details === undefined ? {} : { details }) },
    isError,
  });
  const message = {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: final }],
    isError,
    ...(details === undefined ? {} : { details }),
    timestamp: stamp(),
  } as unknown as AgentMessage;
  events.push({ type: "message_start", message }, { type: "message_end", message });
  return events;
}

/**
 * The events pi emits when a run is aborted while a reply streams: the reply ends as
 * aborted, then the run ends.
 */
export function abortedRun(): SessionEvent[] {
  return [
    { type: "message_end", message: assistantMessage([], "aborted", "Operation aborted") },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

/** Wraps turns in the agent lifecycle events that bracket every run. */
export function agentRun(turns: SessionEvent[][]): SessionEvent[] {
  return [
    { type: "agent_start" },
    { type: "turn_start" },
    ...turns.flat(),
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ];
}

function update(assistantMessageEvent: Delta, spent: typeof USAGE): SessionEvent {
  return { type: "message_update", usage: spent, assistantMessageEvent };
}

/** Messages as a stored session holds them, which is what `get_messages` returns. */
export const stored = {
  user: (text: string): AgentMessage =>
    ({ role: "user", content: text, timestamp: stamp() }) as unknown as AgentMessage,

  assistant: (options: Omit<AssistantTurnOptions, "parts">): AgentMessage => {
    const content: Content = [];
    if (options.thinking) content.push({ type: "thinking", thinking: options.thinking });
    if (options.text) content.push({ type: "text", text: options.text });
    if (options.toolCall) {
      const { id, name, args } = options.toolCall;
      content.push({ type: "toolCall", id, name, arguments: args });
    }
    return assistantMessage(content, options.toolCall ? "toolUse" : "stop");
  },

  toolResult: (options: { id: string; name: string; output: string; isError?: boolean; details?: unknown }) =>
    ({
      role: "toolResult",
      toolCallId: options.id,
      toolName: options.name,
      content: [{ type: "text", text: options.output }],
      isError: options.isError ?? false,
      ...(options.details === undefined ? {} : { details: options.details }),
      timestamp: stamp(),
    }) as unknown as AgentMessage,

  custom: (options: { customType: string; text: string; details?: unknown }) =>
    ({
      role: "custom",
      customType: options.customType,
      content: options.text,
      ...(options.details === undefined ? {} : { details: options.details }),
      timestamp: stamp(),
    }) as unknown as AgentMessage,

  compaction: (summary: string, tokensBefore: number) =>
    ({ role: "compactionSummary", summary, tokensBefore, timestamp: stamp() }) as unknown as AgentMessage,
};

/** A host-attributed native domain message in a conversation. */
export function customTurn(message: AgentMessage): SessionEvent[] {
  return [
    { type: "message_start", message },
    { type: "message_end", message },
  ];
}
