import type { SessionEvent } from "./protocol.ts";

/** One presentation frame at 30fps, the rate streamed text is applied at. */
export const MESSAGE_FLUSH_MS = 33;

/** Tool output arrives as cumulative snapshots, so it can be sampled far more coarsely. */
export const TOOL_FLUSH_MS = 250;

export const MAX_PENDING = 512;

type Timer = ReturnType<typeof setTimeout>;

export interface EventPacerOptions {
  /** Applies one event to the view. */
  apply: (event: SessionEvent) => void;
  /** Runs after a group of events has been applied, once per repaint. */
  onFlush?: () => void;
  messageFlushMs?: number;
  toolFlushMs?: number;
  maxPending?: number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
}

/**
 * Rate-limits the two high-volume event streams so a fast agent cannot outrun the
 * renderer, at the cost of at most one flush interval of latency.
 *
 * Assistant deltas are applied in order within a frame. Tool updates carry the whole
 * output so far, so only the newest one per tool call has to be applied. Every other
 * event is a barrier: pending work is applied first, then the event, immediately.
 */
export class EventPacer {
  private readonly messages: SessionEvent[] = [];
  private readonly tools = new Map<string, SessionEvent>();
  private messageTimer: Timer | undefined;
  private toolTimer: Timer | undefined;
  private disposed = false;

  private readonly apply: (event: SessionEvent) => void;
  private readonly onFlush: () => void;
  private readonly messageFlushMs: number;
  private readonly toolFlushMs: number;
  private readonly maxPending: number;
  private readonly schedule: (callback: () => void, delayMs: number) => Timer;
  private readonly cancelTimer: (timer: Timer) => void;

  constructor(options: EventPacerOptions) {
    this.apply = options.apply;
    this.onFlush = options.onFlush ?? (() => {});
    this.messageFlushMs = options.messageFlushMs ?? MESSAGE_FLUSH_MS;
    this.toolFlushMs = options.toolFlushMs ?? TOOL_FLUSH_MS;
    this.maxPending = Math.max(1, options.maxPending ?? MAX_PENDING);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  handle(event: SessionEvent): void {
    if (this.disposed) return;

    if (event.type === "message_update") {
      this.messages.push(event);
      if (this.messages.length >= this.maxPending) this.flush();
      else this.arm("message");
      return;
    }

    if (event.type === "tool_execution_update") {
      this.tools.set(event.toolCallId, event);
      if (this.tools.size >= this.maxPending) this.flush();
      else this.arm("tool");
      return;
    }

    // The final result supersedes any sampled output for that call.
    if (event.type === "tool_execution_end") this.tools.delete(event.toolCallId);

    this.flushPending();
    this.apply(event);
    this.onFlush();
  }

  /** Applies everything pending, for shutdown or before reading the view synchronously. */
  flush(): void {
    if (this.disposed) return;
    if (this.flushPending()) this.onFlush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    this.disarm("message");
    this.disarm("tool");
  }

  private arm(lane: "message" | "tool"): void {
    if (lane === "message") {
      if (this.messageTimer !== undefined) return;
      this.messageTimer = this.schedule(() => {
        this.messageTimer = undefined;
        this.flush();
      }, this.messageFlushMs);
      return;
    }
    if (this.toolTimer !== undefined) return;
    this.toolTimer = this.schedule(() => {
      this.toolTimer = undefined;
      this.flush();
    }, this.toolFlushMs);
  }

  private disarm(lane: "message" | "tool"): void {
    if (lane === "message") {
      if (this.messageTimer !== undefined) this.cancelTimer(this.messageTimer);
      this.messageTimer = undefined;
      return;
    }
    if (this.toolTimer !== undefined) this.cancelTimer(this.toolTimer);
    this.toolTimer = undefined;
  }

  /** True when anything was applied. */
  private flushPending(): boolean {
    const hadMessages = this.messages.length > 0;
    const hadTools = this.tools.size > 0;
    if (!hadMessages && !hadTools) return false;
    this.disarm("message");
    this.disarm("tool");
    for (const event of this.messages.splice(0)) this.apply(event);
    for (const event of [...this.tools.values()]) this.apply(event);
    this.tools.clear();
    return true;
  }
}
