import type { CommandResult, SessionCommand, SessionEvent, SessionState, SessionStats } from "./protocol.ts";

/** An attachment to a native conversation. Closing it never stops the conversation. */
export interface ConversationLink {
  onEvent(listener: (event: SessionEvent, sequence: number) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  getSnapshot(): Promise<SessionSnapshot>;
  call<C extends SessionCommand>(command: C): Promise<CommandResult<C["type"]>>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void>;
  abort(): Promise<void>;
  abortRetry(): Promise<void>;
  getState(): Promise<SessionState>;
  getMessages(): Promise<unknown[]>;
  getSessionStats(): Promise<SessionStats>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  close(): Promise<void>;
}
export interface SessionSnapshot {
  sequence: number;
  state: SessionState;
  messages: readonly unknown[];
  streamingMessage?: unknown;
  retry?: { attempt: number; maxAttempts?: number; at: number; errorMessage: string };
  pendingToolCalls: readonly string[];
  pendingTools?: readonly { callId: string; name: string; output?: string; details?: unknown }[];
  queue?: { steering: readonly string[]; followUp: readonly string[] };
}
