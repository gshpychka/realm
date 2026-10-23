import type { SessionSnapshot } from "./client.ts";
import { contentToText, type SessionEvent } from "./protocol.ts";

export type Phase = "idle" | "streaming" | "compacting" | "retrying";

export type ToolState = "running" | "ok" | "error";

export interface ToolView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  state: ToolState;
  output: string;
  /** Structured result the tool attached, whose shape is the tool's own. */
  details?: unknown;
  /** Milliseconds since the epoch when execution began and ended, as this client saw them. */
  startedAt?: number;
  endedAt?: number;
  /** The arguments' JSON as it streams in, until the call is complete. */
  streaming?: string;
}

export interface UserEntry {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantEntry {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  tools: ToolView[];
  done: boolean;
  stopReason?: string;
}

/**
 * Changes the client makes to the view itself: a command the operator runs streams as
 * events, but pi adds its record to the session without one.
 */
export type LocalAction =
  /** The agent process is gone, so nothing it was doing is still in progress. */
  | { type: "closed" }
  /** Recovers the last known queue after the agent has disconnected. */
  | { type: "queue_taken" }
  /** Whether a dialog pi waits on is open, which holds the run up until the operator answers. */
  | { type: "waiting"; waiting: boolean };

export type SessionAction = SessionEvent | LocalAction;

export interface NoticeEntry {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
  local?: boolean;
}

/** A native domain message with host attribution, such as an inter-agent inbox delivery. */
export interface CustomEntry {
  kind: "custom";
  id: string;
  customType: string;
  text: string;
  details?: unknown;
}

/** History pi folded into a summary: a compaction, or a branch left behind. */
export interface SummaryEntry {
  kind: "summary";
  id: string;
  of: "compaction";
  text: string;
  /** Context tokens before a compaction. */
  tokensBefore?: number;
}

/** How a turn ended, when it did not end with a finished reply. */
export type Outcome = "interrupted" | "error";

/** The figures of a turn this client watched from its start to its end. */
export interface TurnEntry {
  kind: "turn";
  id: string;
  /** Milliseconds the turn worked, less the time it waited on the operator. */
  worked: number;
  /** Output tokens the turn's replies generated. */
  output: number;
  /** Tool calls pi ran in the turn. */
  tools: number;
  /** When the turn ended, in milliseconds since the epoch. */
  endedAt: number;
  outcome?: Outcome;
  /** The key of the session message the turn ended on. */
  after?: string;
}

export type Entry = UserEntry | AssistantEntry | NoticeEntry | CustomEntry | SummaryEntry | TurnEntry;

export interface SessionView {
  phase: Phase;
  /** True between `agent_start` and `agent_end`. */
  running: boolean;
  entries: Entry[];
  queue: { steering: readonly string[]; followUp: readonly string[] };
  /** Status detail for the footer: retry attempt, compaction reason, or the last error. */
  detail: string | null;
  /** Monotonic entry counter, kept in state so ids stay stable across reductions. */
  seq: number;
  /** Messages completed so far, which is what pi counts in `messageCount`. */
  messages: number;
  /** When the run in progress began, in milliseconds since the epoch, as this client saw it. */
  startedAt: number | null;
  /** The automatic retry pi is waiting to make, while it waits. */
  retry: Retry | null;
  /** When the operator began holding pi up with an open dialog, while one is open. */
  waitingSince: number | null;
  /** Milliseconds the run in progress has spent waiting on the operator, besides a wait still open. */
  waited: number;
  /** Output tokens the run in progress has generated: its finished replies, and the reply streaming so far. */
  output: { finished: number; streaming: number };
  /** What the run in progress has done, when this client saw it begin. */
  turn: TurnSoFar | null;
}

export interface TurnSoFar {
  /** Tool calls pi has begun running. */
  tools: number;
  /** How the latest reply ended, when not with a finished one. */
  outcome: Outcome | null;
  /** The key of the latest message pi recorded. */
  last: string | null;
}

export interface Retry {
  attempt: number;
  maxAttempts?: number;
  /** When the next attempt starts, in milliseconds since the epoch. */
  at: number;
  error: string;
}

export const emptySession: SessionView = {
  phase: "idle",
  running: false,
  entries: [],
  queue: { steering: [], followUp: [] },
  detail: null,
  seq: 0,
  messages: 0,
  startedAt: null,
  retry: null,
  waitingSince: null,
  waited: 0,
  output: { finished: 0, streaming: 0 },
  turn: null,
};

interface Message {
  role?: string;
  entryId?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean;
  customType?: string;
  summary?: string;
  tokensBefore?: number;
  stopReason?: string;
  errorMessage?: string;
  usage?: { output?: number };
  timestamp?: number;
}

/** A key that picks `message` out of its session: pi stamps each message with the time it made it. */
function place(message: Message): string | null {
  return message.entryId ?? (message.timestamp === undefined ? null : `${message.role}@${message.timestamp}`);
}

/**
 * The conversation a stored session holds, as a view. A tool call with no result in
 * the session never finished, so it shows as interrupted. When `previous` is a view of
 * the same session, each turn summary it holds follows the message its turn ended on.
 */
export function restore(
  messages: readonly unknown[],
  previous?: SessionView,
  live?: SessionSnapshot,
): SessionView {
  const kept = new Map<string, TurnEntry>();
  for (const entry of previous?.entries ?? [])
    if (entry.kind === "turn" && entry.after !== undefined) kept.set(entry.after, entry);
  let view = messages.reduce<SessionView>((state, message) => {
    const next = reduce(reduce(state, { type: "message_start", message } as SessionEvent), {
      type: "message_end",
      message,
    } as SessionEvent);
    const key = place(message as Message);
    const turn = key === null ? undefined : kept.get(key);
    if (key === null || !turn) return next;
    kept.delete(key);
    return append(next, (id) => ({ ...turn, id }));
  }, emptySession);
  const pending = new Set(live?.pendingToolCalls);
  view = { ...view, entries: view.entries.map((entry) => interrupted(entry, pending)) };
  if (live?.state.isStreaming) {
    view = reduce(view, { type: "agent_start" });
    if (live.streamingMessage) {
      const message = live.streamingMessage as Message;
      view = startMessage(view, message);
      view = patchAssistant(view, (entry) => ({ ...settle(entry, message), done: false }));
    }
  }
  if (live?.state.isCompacting) view = { ...view, phase: "compacting" };
  if (live?.queue) view = { ...view, queue: live.queue };
  for (const entry of previous?.entries ?? [])
    if (entry.kind === "notice" && entry.local) view = append(view, (id) => ({ ...entry, id }));
  return view;
}

/** The entry with each tool call it left running marked as interrupted, since none will finish. */
function interrupted(entry: Entry, pending: ReadonlySet<string>): Entry {
  if (entry.kind !== "assistant" || !entry.tools.some((tool) => tool.state === "running")) return entry;
  const stop = (tool: ToolView): ToolView =>
    tool.state === "running" && !pending.has(tool.id)
      ? { ...tool, state: "error", output: tool.output || "interrupted" }
      : tool;
  return { ...entry, tools: entry.tools.map(stop) };
}

/**
 * The view without the reply that failed and its error notice, which pi drops from the
 * session when it retries.
 */
function withoutFailedAttempt(state: SessionView): SessionView {
  const index = state.entries.findLastIndex((entry) => entry.kind === "assistant");
  const failed = state.entries[index];
  if (failed?.kind !== "assistant" || failed.stopReason !== "error") return state;
  const after = state.entries[index + 1];
  const drop = after?.kind === "notice" && after.level === "error" ? 2 : 1;
  const entries = [...state.entries];
  entries.splice(index, drop);
  return { ...state, entries, messages: Math.max(0, state.messages - 1), detail: null };
}

/**
 * Folds one native presentation event into the rendered conversation.
 *
 * The event stream is the only source of conversation content: pi emits
 * `message_start`/`message_end` for user and tool-result messages too, so the view
 * needs no local echo of what the operator typed.
 */
export function reduce(state: SessionView, event: SessionAction, now = Date.now()): SessionView {
  switch (event.type) {
    case "closed": {
      const closed = closeOpenAssistant(state);
      return {
        ...closed,
        running: false,
        phase: "idle",
        startedAt: null,
        retry: null,
        waited: 0,
        waitingSince: null,
        output: emptySession.output,
        turn: null,
        entries: closed.entries.map((entry) => {
          if (entry.kind !== "assistant") return entry;
          return {
            ...entry,
            tools: entry.tools.map((tool) =>
              tool.state === "running"
                ? { ...tool, state: "error" as const, endedAt: now, output: tool.output || "interrupted" }
                : tool,
            ),
          };
        }),
      };
    }

    case "queue_taken":
      return { ...state, queue: emptySession.queue };

    case "agent_start":
      // A retry or a continuation joins the run in progress, whose clock and turn run from its first start.
      return {
        ...state,
        running: true,
        phase: "streaming",
        detail: null,
        startedAt: state.startedAt ?? now,
        turn: state.startedAt === null ? { tools: 0, outcome: null, last: null } : state.turn,
      };

    case "agent_end":
      // A run that will retry emits another agent_start, so only agent_settled ends it.
      return event.willRetry ? state : closeOpenAssistant(state);

    case "agent_settled": {
      const settled: SessionView = {
        ...closeOpenAssistant(state),
        running: false,
        phase: "idle",
        startedAt: null,
        retry: null,
        waited: 0,
        output: emptySession.output,
        turn: null,
      };
      const { turn } = state;
      if (!turn) return settled;
      return append(settled, (id) => ({
        kind: "turn",
        id,
        worked: elapsed(state, now),
        output: state.output.finished + state.output.streaming,
        tools: turn.tools,
        endedAt: now,
        ...(turn.outcome === null ? {} : { outcome: turn.outcome }),
        ...(turn.last === null ? {} : { after: turn.last }),
      }));
    }

    case "waiting": {
      if (event.waiting) return state.waitingSince === null ? { ...state, waitingSince: now } : state;
      if (state.waitingSince === null) return state;
      // A wait that opened before the run began holds it up only from its start.
      const held = state.startedAt === null ? 0 : now - Math.max(state.waitingSince, state.startedAt);
      return { ...state, waitingSince: null, waited: state.waited + Math.max(0, held) };
    }

    case "message_start":
      return startMessage(state, event.message as Message);

    case "message_update": {
      const streaming = state.running ? event.usage?.output : undefined;
      const next = applyDelta(state, event.assistantMessageEvent);
      return streaming === undefined ? next : { ...next, output: { ...next.output, streaming } };
    }

    case "message_end": {
      const message = event.message as Message;
      const counted = { ...state, messages: state.messages + 1, turn: recorded(state.turn, message) };
      if (message.role !== "assistant") return counted;
      const { finished, streaming } = state.output;
      const metered = state.running
        ? { ...counted, output: { finished: finished + (message.usage?.output ?? streaming), streaming: 0 } }
        : counted;
      // The committed native message is authoritative over the partial deltas.
      const done = closeOpenAssistant(patchAssistant(metered, (entry) => settle(entry, message)));
      if (message.stopReason === "error")
        return note(done, "error", message.errorMessage || "the request failed");
      if (message.stopReason === "aborted") return note(done, "info", "aborted");
      return done;
    }

    case "tool_execution_start":
      return patchTool(counting(state), event.toolCallId, (tool) => ({
        ...tool,
        name: event.toolName ?? tool.name,
        args: (event.args as Record<string, unknown>) ?? tool.args,
        state: "running",
        startedAt: tool.startedAt ?? now,
      }));

    case "tool_execution_update": {
      const partial = event.partialResult as { content?: unknown; details?: unknown } | undefined;
      return patchTool(state, event.toolCallId, (tool) => ({
        ...tool,
        output: contentToText(partial?.content),
        ...(partial?.details === undefined ? {} : { details: partial.details }),
      }));
    }

    case "tool_execution_end": {
      const result = event.result as { content?: unknown; details?: unknown } | undefined;
      return patchTool(state, event.toolCallId, (tool) => ({
        ...tool,
        state: event.isError ? "error" : "ok",
        endedAt: now,
        output: contentToText(result?.content) || tool.output,
        ...(result?.details === undefined ? {} : { details: result.details }),
      }));
    }

    case "queue_update":
      return { ...state, queue: { steering: event.steering, followUp: event.followUp } };

    case "compaction_start":
      return { ...state, phase: "compacting", detail: `compacting (${event.reason})` };

    case "compaction_end": {
      const detail = event.errorMessage ?? (event.aborted ? "compaction aborted" : null);
      return { ...state, phase: state.running ? "streaming" : "idle", detail };
    }

    case "auto_retry_start":
      return {
        ...withoutFailedAttempt(state),
        phase: "retrying",
        detail: null,
        retry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          at: now + event.delayMs,
          error: event.errorMessage,
        },
      };

    case "auto_retry_end":
      if (event.success)
        return { ...state, phase: state.running ? "streaming" : "idle", detail: null, retry: null };
      return {
        ...note(state, "error", event.finalError ?? "retry failed"),
        phase: "idle",
        running: false,
        retry: null,
      };

    case "runtime_error":
      return note(state, "error", `${event.source}: ${event.error}`);

    default:
      return state;
  }
}

/** How a turn ended, by the stop reason of its last reply, when it did not end with a finished one. */
const OUTCOMES = new Map<string, Outcome>([
  ["aborted", "interrupted"],
  ["error", "error"],
]);

function recorded(turn: TurnSoFar | null, message: Message): TurnSoFar | null {
  if (!turn) return turn;
  const last = place(message);
  if (message.role !== "assistant") return { ...turn, last };
  return { ...turn, last, outcome: OUTCOMES.get(message.stopReason ?? "") ?? null };
}

function counting(state: SessionView): SessionView {
  return state.turn ? { ...state, turn: { ...state.turn, tools: state.turn.tools + 1 } } : state;
}

export function reduceAll(state: SessionView, events: SessionAction[]): SessionView {
  return events.reduce((view, event) => reduce(view, event), state);
}

/** Milliseconds the run in progress has taken by `now`, less the time it spent waiting on the operator. */
export function elapsed(view: SessionView, now: number): number {
  if (view.startedAt === null) return 0;
  const until = view.waitingSince === null ? now : Math.max(view.waitingSince, view.startedAt);
  return Math.max(0, until - view.startedAt - view.waited);
}

/** What the run in progress is doing. */
export type Activity =
  /** The model takes in its input, the latest tool results among it, with nothing of its reply streamed yet. */
  | { kind: "reading" }
  /** The reply streams its reasoning, with no answer or tool call yet. */
  | { kind: "thinking" }
  /** The model streams its answer or a tool call. */
  | { kind: "writing" }
  /** pi runs the latest reply's tool calls, or is about to; `names` lists those still unfinished. */
  | { kind: "tools"; names: string[] }
  /** pi waits on the operator to answer a dialog. */
  | { kind: "operator" };

export function activityOf(view: SessionView): Activity {
  if (view.waitingSince !== null) return { kind: "operator" };
  const latest = view.entries.findLast((entry) => entry.kind === "assistant" || entry.kind === "user");
  if (latest?.kind !== "assistant") return { kind: "reading" };
  if (!latest.done) {
    if (latest.text || latest.tools.length > 0) return { kind: "writing" };
    return latest.thinking ? { kind: "thinking" } : { kind: "reading" };
  }
  const names = latest.tools.flatMap((tool) => (tool.state === "running" ? [tool.name] : []));
  return names.length > 0 ? { kind: "tools", names } : { kind: "reading" };
}

/** Plain-text transcript of the conversation pi holds, used by tests and snapshots. */
export function transcript(state: SessionView): string {
  const lines: string[] = [];
  for (const entry of state.entries) {
    switch (entry.kind) {
      case "user":
        lines.push(`> ${entry.text}`);
        break;
      case "assistant":
        if (entry.thinking) lines.push(`~ ${entry.thinking}`);
        if (entry.text) lines.push(entry.text);
        for (const tool of entry.tools) lines.push(`[${tool.state}] ${tool.name} ${tool.output}`.trimEnd());
        break;
      case "notice":
        lines.push(`! ${entry.text}`);
        break;
      case "custom":
        lines.push(`[${entry.customType}] ${entry.text}`);
        break;
      case "summary":
        lines.push(`[${entry.of}] ${entry.text}`);
        break;
      case "turn":
        // A turn's figures are not part of what was said.
        break;
      default:
        entry satisfies never;
    }
  }
  return lines.join("\n");
}

function startMessage(state: SessionView, message: Message): SessionView {
  switch (message.role) {
    case "user":
      return append(state, (id) => ({ kind: "user", id, text: contentToText(message.content) }));
    case "assistant":
      return append(state, (id) => ({
        kind: "assistant",
        id,
        text: "",
        thinking: "",
        tools: [],
        done: false,
      }));
    case "toolResult": {
      const toolCallId = message.toolCallId;
      if (!toolCallId) return state;
      return patchTool(state, toolCallId, (tool) => ({
        ...tool,
        name: message.toolName ?? tool.name,
        state: resultState(tool, message),
        output: contentToText(message.content) || tool.output,
        ...(message.details === undefined ? {} : { details: message.details }),
      }));
    }
    case "custom":
      return append(state, (id) => ({
        kind: "custom",
        id,
        customType: message.customType ?? "custom",
        text: contentToText(message.content),
        ...(message.details === undefined ? {} : { details: message.details }),
      }));
    case "compactionSummary":
      return append(state, (id) => ({
        kind: "summary",
        id,
        of: "compaction",
        text: message.summary ?? "",
        ...(message.tokensBefore === undefined ? {} : { tokensBefore: message.tokensBefore }),
      }));
    default:
      return state;
  }
}

/** A call's state once `result` arrives: failed when the result says so, finished when it was running. */
function resultState(tool: ToolView, result: Message): ToolState {
  if (result.isError) return "error";
  return tool.state === "running" ? "ok" : tool.state;
}

/**
 * An assistant entry brought up to its final message: text, thinking, and tool calls
 * from the content blocks, keeping execution state already reported for each call.
 */
function settle(entry: AssistantEntry, message: Message): AssistantEntry {
  const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
  if (blocks.length === 0) return message.stopReason ? { ...entry, stopReason: message.stopReason } : entry;
  const joined = (type: string, field: string) =>
    blocks.flatMap((block) => (block.type === type ? [String(block[field] ?? "")] : [])).join("\n");
  const calls = blocks.filter((block) => block.type === "toolCall");
  const tools = calls.map((call) => {
    const id = String(call.id ?? "");
    const known = entry.tools.find((tool) => tool.id === id);
    const args = (call.arguments as Record<string, unknown> | undefined) ?? known?.args ?? {};
    return known
      ? { ...known, args }
      : { id, name: String(call.name ?? ""), args, state: "running" as const, output: "" };
  });
  const extra = entry.tools.filter((tool) => !calls.some((call) => call.id === tool.id));
  return {
    ...entry,
    text: joined("text", "text") || entry.text,
    thinking: joined("thinking", "thinking") || entry.thinking,
    tools: [...tools, ...extra],
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
  };
}

type AssistantDelta = { type: string } & Record<string, unknown>;

/**
 * One streamed change to the reply. Separate text or thinking blocks are joined by a
 * blank line; the message's end replaces what streamed with the whole message.
 */
function applyDelta(state: SessionView, delta: AssistantDelta): SessionView {
  switch (delta.type) {
    case "text_start":
      return patchAssistant(state, (entry) => (entry.text ? { ...entry, text: `${entry.text}\n\n` } : entry));
    case "text_delta":
      return patchAssistant(state, (entry) => ({ ...entry, text: entry.text + String(delta.delta ?? "") }));
    case "thinking_start":
      return patchAssistant(state, (entry) =>
        entry.thinking ? { ...entry, thinking: `${entry.thinking}\n\n` } : entry,
      );
    case "thinking_delta":
      return patchAssistant(state, (entry) => ({
        ...entry,
        thinking: entry.thinking + String(delta.delta ?? ""),
      }));
    case "toolcall_start": {
      const id = String(delta.id ?? "");
      return patchAssistant(state, (entry) =>
        !id || entry.tools.some((tool) => tool.id === id)
          ? entry
          : {
              ...entry,
              tools: [
                ...entry.tools,
                {
                  id,
                  name: String(delta.toolName ?? ""),
                  args: {},
                  state: "running",
                  output: "",
                  streaming: "",
                },
              ],
            },
      );
    }
    case "toolcall_delta":
      return patchAssistant(state, (entry) => {
        const index = entry.tools.findLastIndex((tool) => tool.streaming !== undefined);
        const tool = entry.tools[index];
        if (!tool) return entry;
        const streaming = (tool.streaming ?? "") + String(delta.delta ?? "");
        const tools = [...entry.tools];
        tools[index] = { ...tool, streaming, args: partialJson(streaming) ?? tool.args };
        return { ...entry, tools };
      });
    case "toolcall_end": {
      const call = delta.toolCall as { id: string; name: string; arguments?: Record<string, unknown> };
      return patchAssistant(state, (entry) => {
        const known = entry.tools.findIndex((tool) => tool.id === call.id);
        // A call whose arguments are complete has none left streaming in.
        const { streaming: _streaming, ...before } = entry.tools[known] ?? {
          id: call.id,
          state: "running" as const,
          output: "",
        };
        const settled: ToolView = { ...before, name: call.name, args: call.arguments ?? {} };
        const tools = [...entry.tools];
        if (known === -1) tools.push(settled);
        else tools[known] = settled;
        return { ...entry, tools };
      });
    }
    default:
      return state;
  }
}

/** Arguments from JSON still arriving: what parses once the open strings and objects are closed. */
export function partialJson(text: string): Record<string, unknown> | null {
  for (const tail of ["", '"}', "}", '"]}', "]}", '""}', "null}"]) {
    try {
      const value = JSON.parse(text + tail) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      // Not yet whole with this closing; the next one may be.
    }
  }
  return null;
}

function append(state: SessionView, make: (id: string) => Entry): SessionView {
  const seq = state.seq + 1;
  return { ...state, seq, entries: [...state.entries, make(`e${seq}`)] };
}

/** The conversation with a notice appended; an error also becomes the footer detail. */
export function note(
  state: SessionView,
  level: NoticeEntry["level"],
  text: string,
  local = false,
): SessionView {
  const next = append(state, (id) => ({
    kind: "notice",
    id,
    level,
    text,
    ...(local ? { local: true } : {}),
  }));
  return level === "error" ? { ...next, detail: text } : next;
}

/** The assistant entry currently receiving deltas, which is always the last one. */
function patchAssistant(state: SessionView, patch: (entry: AssistantEntry) => AssistantEntry): SessionView {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry?.kind !== "assistant") continue;
    if (entry.done) break;
    const entries = [...state.entries];
    entries[index] = patch(entry);
    return { ...state, entries };
  }
  return state;
}

function closeOpenAssistant(state: SessionView): SessionView {
  return patchAssistant(state, (entry) => ({ ...entry, done: true }));
}

/**
 * Applies `patch` to the tool call with `toolCallId`, creating it when execution
 * events arrive before the tool call has finished streaming.
 */
function patchTool(state: SessionView, toolCallId: string, patch: (tool: ToolView) => ToolView): SessionView {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    if (entry?.kind !== "assistant") continue;
    const toolIndex = entry.tools.findIndex((tool) => tool.id === toolCallId);
    if (toolIndex === -1) continue;
    const tools = [...entry.tools];
    const existing = tools[toolIndex];
    if (!existing) continue;
    tools[toolIndex] = patch(existing);
    const entries = [...state.entries];
    entries[index] = { ...entry, tools };
    return { ...state, entries };
  }
  return patchAssistant(state, (entry) => ({
    ...entry,
    tools: [...entry.tools, patch({ id: toolCallId, name: "", args: {}, state: "running", output: "" })],
  }));
}
