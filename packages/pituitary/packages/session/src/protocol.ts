import type { ImageContent, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

/** The stable presentation contract shared by the native conversation and terminal view. */
export interface SessionState {
  model?: Model<string>;
  thinkingLevel: ModelThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}
export interface SessionStats {
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { percent: number };
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export type MessageDelta =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };
export interface ToolResult {
  content: unknown;
  details?: unknown;
}
export type SessionEvent =
  | { type: "message_start"; message: unknown }
  | { type: "message_end"; message: unknown }
  | { type: "message_update"; assistantMessageEvent: MessageDelta; usage?: Usage }
  | { type: "agent_start" | "agent_settled" | "turn_start" | "turn_end" | "session_info_changed" }
  | { type: "agent_end"; messages?: unknown[]; willRetry?: boolean }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: ToolResult;
    }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; errorMessage?: string; aborted?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts?: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; finalError?: string; attempt?: number }
  | { type: "runtime_error"; source: string; event: string; error: string };

type InputCommand = {
  type: "prompt" | "steer" | "follow_up";
  message: string;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
};
export type SessionCommand = (
  | InputCommand
  | {
      type:
        | "abort"
        | "abort_retry"
        | "clear_queue"
        | "get_state"
        | "get_messages"
        | "get_session_stats"
        | "get_available_models"
        | "get_available_thinking_levels"
        | "get_last_assistant_text"
        | "cycle_model"
        | "cycle_thinking_level";
    }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ModelThinkingLevel }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_session_name"; name: string }
) & { id?: string };
interface CommandResults {
  get_state: SessionState;
  get_messages: { messages: unknown[] };
  get_session_stats: SessionStats;
  get_available_models: { models: Model<string>[] };
  get_available_thinking_levels: { levels: ModelThinkingLevel[] };
  get_last_assistant_text: { text: string | null };
  set_model: Model<string>;
  cycle_model: { model: Model<string> } | null;
  cycle_thinking_level: { level: ModelThinkingLevel };
  clear_queue: { steering: string[]; followUp: string[] };
  compact: { taskId: string };
}
export type CommandResult<T extends SessionCommand["type"]> = T extends keyof CommandResults
  ? CommandResults[T]
  : undefined;

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "string"
        ? block
        : block && typeof block === "object" && "text" in block
          ? String(block.text)
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

const SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this removes
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[ -/]*[0-~]?/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * `text` safe to put on the operator's terminal: escape sequences removed until none
 * remain, since removing one can join the pieces around it into another, then every
 * control character but newline and tab.
 *
 * Model output, domain messages, and the raw
 * bytes a tool read from a file.
 */
export function plain(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(SEQUENCE, "");
    if (next === current) break;
    current = next;
  }
  return current.replace(CONTROL, "");
}

/** `value` with every string inside it made `plain`. */
export function scrub<T>(value: T): T {
  if (typeof value === "string") return plain(value) as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [plain(key), scrub(entry)])) as T;
  }
  return value;
}
