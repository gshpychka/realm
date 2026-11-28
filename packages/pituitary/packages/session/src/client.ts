import type {
  BashResult,
  CommandResult,
  ImageContent,
  SessionCommand,
  SessionEvent,
  SessionState,
  SessionStats,
} from "./protocol.ts";

/** A conversation's presentation port. Each backend owns its connection and process lifetime. */
export interface ConversationLink {
  onEvent(listener: (event: SessionEvent, sequence: number) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  getSnapshot(): Promise<SessionSnapshot>;
  call<C extends SessionCommand>(command: C): Promise<CommandResult<C["type"]>>;
  prompt(message: string, streamingBehavior?: "steer" | "followUp", images?: ImageContent[]): Promise<void>;
  abort(): Promise<void>;
  abortRetry(): Promise<void>;
  getState(): Promise<SessionState>;
  getMessages(): Promise<unknown[]>;
  getSessionStats(): Promise<SessionStats>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  close(): Promise<void>;
  /**
   * Each time the link moves to another session, such as Pi's new, forked or resumed ones.
   * Listeners start the view afresh: nothing the previous session showed belongs to the next.
   */
  onReplace?(listener: () => void): () => void;
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
  /**
   * The operator's shell commands Pi has yet to record: those still running, and those that
   * ended during a run, which Pi records only once the run ends.
   */
  shells?: readonly UnrecordedShell[];
}
/** A shell command the operator ran that Pi has yet to record, with its output so far. */
export interface UnrecordedShell {
  /** The request that runs it, which its streamed output names. */
  id: string;
  command: string;
  excludeFromContext: boolean;
  output: string;
  /** How it ended, once it has. */
  result?: BashResult;
}
