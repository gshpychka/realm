import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import {
  type BashResult,
  type CommandResult,
  type ConversationLink,
  encodeJsonLine,
  type ImageContent,
  JsonLineDecoder,
  type SessionCommand,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
  type SessionStats,
  SHELL_OUTPUT_LIMIT,
  scrub,
  type UnrecordedShell,
} from "@pituitary/session";
import type { ConsultLaunch } from "./consult/consult.ts";
import type { Keymap } from "./keymap.ts";
import {
  BRIDGE_STATUS,
  type BridgeCall,
  type BridgeKind,
  type BridgeReply,
  type BridgeRequest,
  type BridgeResult,
  decodeReply,
  decodeRuntime,
  encodeCall,
  RUNTIME_STATUS,
  readResult,
} from "./pi-bridge.ts";
import { type BranchPrompt, branchPrompts } from "./pi-sessions.ts";

export type PiUiRequest = { type: "extension_ui_request"; id: string } & (
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; title: string; message: string; timeout?: number }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string }
  | { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { method: "setStatus"; statusKey: string; statusText?: string }
  | {
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
);
export type PiUiResponse = { type: "extension_ui_response"; id: string } & (
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
);
export interface PiUiPort {
  onRequest(listener: (request: PiUiRequest) => void): () => void;
  respond(response: PiUiResponse): void;
}
export interface PiOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Pituitary's bridge extension, which `args` loads; Pi's name for its command is found by this file. */
  bridge?: string;
  /** Receives Pi's stderr and what this adapter cannot present. */
  log?(text: string): void;
  /** Receives Pi's stderr in place of `log`, such as a consultant's, whose failure Pi gives only there. */
  stderr?(text: string): void;
}

type RpcType = RpcCommand["type"];
/** What Pi answers a command of `type` with. */
export type RpcData<T extends RpcType> =
  Extract<RpcResponse, { command: T; success: true }> extends infer R
    ? R extends { data: infer D }
      ? D
      : undefined
    : never;
/** A command Pi's extensions, prompt templates or skills register. */
export type PiCommandInfo = RpcData<"get_commands">["commands"][number];

/** Where a Pi connection works and what it can be asked, beyond the conversation itself. */
export interface PiWorkspace {
  /** Pi's working directory, which moves with a session resumed from another project. */
  cwd: string;
  /** What Pi's extensions, prompt templates and skills offer, as Pi names them. */
  commands: readonly PiCommandInfo[];
  /** What each prompt template takes, by name, as the bridge reports it; none without the bridge. */
  argumentHints: Readonly<Record<string, string>>;
  /** Pi's name for the bridge's command: null when Pi has not loaded it, undefined until its commands load. */
  bridge?: string | null;
}

/** What the App does with regular Pi. Dura conversations have none of it. */
export interface PiControls {
  conversation: PiConversation;
  /** Runs one of Pi's own screens, such as `/login`, on the current session, then reconnects. */
  handoff(command: string): Promise<void>;
  /** Opens the session picker once the session loads, for `pituitary --resume`. */
  resumeAtStart?: boolean;
  /** Reads Pi's keybindings with Pituitary's own over them, at start and after each /reload. */
  keymap(): Keymap;
  /** How a second opinion's consultant starts its own Pi. */
  consult: ConsultLaunch;
}

type Pending = { resolve(data: unknown): void; reject(error: Error): void };
/** What a runtime reports as it starts that belongs to the conversation it starts. */
type Held = Extract<PiUiRequest, { method: "notify" }> | Extract<SessionEvent, { type: "extension_error" }>;
/** Whether a replacing operation's answer says Pi moved to another session. */
const moved = ({ cancelled }: { cancelled: boolean }) => !cancelled;
type Block = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};
const EVENTS = new Set([
  "message_start",
  "message_end",
  "message_update",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "session_info_changed",
  "thinking_level_changed",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "runtime_error",
  "bash_execution_update",
]);

/** What the extension UI hears when a Pi process ends without its runtime saying so. */
const RUNTIME_ENDED: PiUiRequest = {
  type: "extension_ui_request",
  id: "pituitary-runtime-ended",
  method: "setStatus",
  statusKey: RUNTIME_STATUS,
};

/** Pi owns the session. This adapter owns its process and translates only presentation. */
export class PiConversation implements ConversationLink, PiUiPort {
  private child?: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: SessionEvent, sequence: number) => void>();
  private readonly uiListeners = new Set<(request: PiUiRequest) => void>();
  private readonly waitingUi: PiUiRequest[] = [];
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly replaceListeners = new Set<() => void>();
  private readonly workspaceListeners = new Set<() => void>();
  private readonly drainListeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  /** Bridge replies by request id, which arrive just before Pi answers the request's prompt. */
  private readonly replies = new Map<string, BridgeReply>();
  /** Errors Pi reported from the bridge's command, for the requests that get no reply. */
  private readonly bridgeFailures: string[] = [];
  private readonly unpresented = new Set<string>();
  private readonly tools = new Map<
    string,
    { callId: string; name: string; output?: string; details?: unknown }
  >();
  /**
   * The operator's shell commands Pi has yet to record, by the request that runs each: those
   * running, and those that ended during a run, which Pi records only as the run ends.
   */
  private readonly shells = new Map<string, UnrecordedShell>();
  private nextId = 0;
  private sequence = 0;
  private closed?: string;
  private closing?: Promise<void>;
  private loading: Promise<void> = Promise.resolve();
  private current: PiWorkspace;
  /** Where the running Pi process started, which its relative paths, such as an export's, are relative to. */
  private launched: string;
  /** Operations under way that may replace the session. */
  private replacing = 0;
  /**
   * A new runtime's startup report, notices and extension failures, held from the old runtime's
   * end until the replacement answers. Keyed so the same report is kept once.
   */
  private held?: Map<string, Held>;
  private streaming?: { role: "assistant"; content: Block[] };
  private running?: boolean;
  private compacting?: boolean;
  private retry?: SessionSnapshot["retry"];
  private queue?: SessionSnapshot["queue"];
  sessionFile?: string;
  sessionId?: string;

  constructor(private readonly options: PiOptions) {
    this.current = { cwd: options.cwd ?? process.cwd(), commands: [], argumentHints: {} };
    this.launched = this.current.cwd;
    this.start(options.args ?? []);
  }

  onEvent(listener: (event: SessionEvent, sequence: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onRequest(listener: (request: PiUiRequest) => void): () => void {
    this.uiListeners.add(listener);
    for (const request of this.waitingUi.splice(0)) listener(request);
    return () => this.uiListeners.delete(listener);
  }
  onClose(listener: (reason: string) => void): () => void {
    if (this.closed) listener(this.closed);
    else this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onReplace(listener: () => void): () => void {
    this.replaceListeners.add(listener);
    return () => this.replaceListeners.delete(listener);
  }
  /** Follows `workspace`, for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.workspaceListeners.add(listener);
    return () => this.workspaceListeners.delete(listener);
  };
  /** Where Pi works and what it offers now; a new object whenever either changes. */
  readonly workspace = (): PiWorkspace => this.current;
  /** Pi's name for a command that the extension in `file` registers. */
  commandOf(file: string): string | undefined {
    return registeredBy(this.current.commands, file);
  }

  respond(response: PiUiResponse): void {
    if (!this.closed) this.child?.stdin.write(encodeJsonLine(response));
  }
  /**
   * One of Pi's RPC commands, answered with its typed data, or with what `read` makes of it.
   * `read` runs as the answer arrives, before any later record in the stream is handled.
   */
  rpc<T extends RpcType, R = RpcData<T>>(
    command: Extract<RpcCommand, { type: T }>,
    read?: (data: RpcData<T>) => R,
  ): Promise<R> {
    return this.send(command, read as ((data: unknown) => R) | undefined);
  }
  async call<C extends SessionCommand>(command: C): Promise<CommandResult<C["type"]>> {
    // The conversation protocol's commands are Pi RPC commands that Dura answers too.
    return (await this.rpc(command as RpcCommand)) as CommandResult<C["type"]>;
  }
  async prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
    images?: ImageContent[],
  ): Promise<void> {
    await this.rpc({
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
      ...(images?.length ? { images } : {}),
    });
  }
  async abort(): Promise<void> {
    await this.rpc({ type: "abort" });
  }
  async abortRetry(): Promise<void> {
    await this.rpc({ type: "abort_retry" });
  }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.rpc({ type: "clear_queue" });
  }
  async getState(): Promise<SessionState> {
    return this.rpc({ type: "get_state" }, (state) => {
      this.sessionFile = state.sessionFile;
      this.sessionId = state.sessionId;
      return state;
    });
  }
  async getMessages(): Promise<unknown[]> {
    return (await this.rpc({ type: "get_messages" })).messages;
  }
  async getSessionStats(): Promise<SessionStats> {
    return this.rpc({ type: "get_session_stats" });
  }
  async getSnapshot(): Promise<SessionSnapshot> {
    const state = await this.getState();
    // Capture the live projection at the response's position in the same JSONL stream.
    // Later records can share its chunk; a Promise continuation would observe them too late.
    return this.rpc({ type: "get_messages" }, ({ messages }) => ({
      sequence: this.sequence,
      state: {
        ...state,
        isStreaming: this.running ?? state.isStreaming,
        isCompacting: this.compacting ?? state.isCompacting,
        messageCount: messages.length,
        pendingMessageCount: this.queue
          ? this.queue.steering.length + this.queue.followUp.length
          : state.pendingMessageCount,
      },
      messages,
      streamingMessage: this.streaming ? structuredClone(this.streaming) : undefined,
      pendingToolCalls: [...this.tools.keys()],
      pendingTools: [...this.tools.values()],
      retry: this.retry,
      queue: this.queue,
      shells: [...this.shells.values()],
    }));
  }

  /**
   * A request to Pituitary's bridge extension, for what Pi's RPC lacks. Refused, with nothing
   * sent, when Pi has not loaded the bridge: an unknown command would reach the model as a prompt.
   */
  async bridge<K extends BridgeKind>(request: BridgeRequest<K>): Promise<BridgeResult<K>> {
    await this.loading;
    const name = this.current.bridge;
    if (!name) throw new Error("Pi has not loaded Pituitary's bridge extension, so nothing was sent to Pi.");
    const id = this.newId();
    const call = { ...request, id } as BridgeCall;
    const { disposition } = await this.send<RpcData<"prompt">>(
      { type: "prompt", message: `/${name} ${encodeCall(call)}` } satisfies RpcCommand,
      undefined,
      id,
    );
    const reply = this.replies.get(id);
    this.replies.delete(id);
    if (!reply) {
      if (disposition !== "handled") throw new Error(`Pi did not run its /${name} command.`);
      throw new Error(this.bridgeFailures.shift() ?? `Pi's /${name} command did not answer.`);
    }
    if (!reply.ok) throw new Error(reply.error);
    // A reload replaces the extensions, whose commands Pi may now name differently.
    if (request.kind === "reload") {
      this.loading = this.loadCommands();
      await this.loading;
    }
    return readResult(request.kind, reply.result);
  }

  /**
   * Runs the operator's shell command through Pi, which records it in the session once it
   * ends: `!` gives its output to the model with the next prompt, `!!`, `excludeFromContext`,
   * keeps it out. Its start, its output as it streams and its end reach the view as events; a
   * command Pi cannot run ends with the reason.
   */
  bash(command: string, excludeFromContext: boolean): Promise<void> {
    const id = this.newId();
    this.shells.set(id, { id, command, excludeFromContext, output: "" });
    this.emit({ type: "bash_start", id, command, excludeFromContext });
    const end = (outcome: { result: BashResult } | { error: string }) => {
      const shell = this.shells.get(id);
      // Under a run Pi holds the command back until the run ends; until then snapshots carry it.
      if (shell && "result" in outcome && this.running) this.shells.set(id, { ...shell, ...outcome });
      else this.shells.delete(id);
      this.emit({ type: "bash_end", id, ...outcome });
    };
    // The end is reported as Pi's answer arrives, before any later record is handled.
    return this.send(
      { type: "bash", command, excludeFromContext } satisfies RpcCommand,
      (data) => end({ result: data as BashResult }),
      id,
    ).catch((error: unknown) => end({ error: error instanceof Error ? error.message : String(error) }));
  }
  /** Whether a shell command the operator ran is still running. */
  get shellRunning(): boolean {
    return [...this.shells.values()].some((shell) => !shell.result);
  }
  /** Stops the operator's running shell command, whose end then says it was cancelled. */
  async abortBash(): Promise<void> {
    await this.rpc({ type: "abort_bash" });
  }
  /**
   * Moves the session to another point of its tree, summarizing the branch it leaves when
   * asked; null when it stayed, by an extension's choice or an abort. Moving to a prompt leaves
   * it to be written again: the session stands just before it, and `text` holds it. The
   * session, its runtime and what it shares with the branch it left stay, so the view reads
   * the branch it is on again rather than starting afresh.
   */
  async navigate(request: Omit<BridgeRequest<"navigate">, "kind">): Promise<{ text: string } | null> {
    const { cancelled, text } = await this.bridge({ kind: "navigate", ...request });
    return cancelled ? null : { text };
  }

  /** Starts a new session. False when an extension kept Pi on this one. */
  async newSession(): Promise<boolean> {
    const { cancelled } = await this.replace(() => this.rpc({ type: "new_session" }), moved);
    return !cancelled;
  }
  /** Forks a new session that ends before the prompt `entryId`, whose text it returns; null when cancelled. */
  async fork(entryId: string): Promise<{ text: string } | null> {
    const { text, cancelled } = await this.replace(() => this.rpc({ type: "fork", entryId }), moved);
    return cancelled ? null : { text };
  }
  /** Copies the current branch into a new session. False when an extension cancelled it. */
  async clone(): Promise<boolean> {
    const { cancelled } = await this.replace(() => this.rpc({ type: "clone" }), moved);
    return !cancelled;
  }
  /** Opens the saved session at `sessionPath`, in the project it was started in. */
  async switchSession(sessionPath: string): Promise<boolean> {
    const { cancelled } = await this.replace(() => this.rpc({ type: "switch_session", sessionPath }), moved);
    return !cancelled;
  }
  /**
   * Writes the session as an HTML page and returns where. Pi writes it relative to the directory
   * its process started in, which a session resumed from another project does not move.
   */
  async exportHtml(outputPath?: string): Promise<string> {
    const launched = this.launched;
    const { path } = await this.rpc({ type: "export_html", ...(outputPath ? { outputPath } : {}) });
    return resolve(launched, path);
  }
  /** The operator's prompts on the current branch, oldest first, with the entries Pi forks at. */
  async branchPrompts(): Promise<BranchPrompt[]> {
    const { entries, leafId } = await this.rpc({ type: "get_entries" });
    return branchPrompts(entries, leafId);
  }

  /**
   * Stops Pi's process for a handoff to its own screens, once its requests are answered. The
   * conversation stays open: `resume` starts Pi again.
   */
  async suspend(): Promise<void> {
    await this.drained();
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.forget();
    this.dispatchUi(RUNTIME_ENDED);
    await stop(child);
  }
  /** Starts Pi again after a handoff, with `args`; landing on another session starts the view afresh. */
  async resume(args: readonly string[]): Promise<void> {
    if (this.child || this.closed) return;
    const before = this.sessionId;
    // What the new process says as it starts waits until it is known whether the session moved.
    this.held = new Map();
    try {
      this.start(args);
      const { sessionId } = await this.getState();
      if (sessionId !== before) this.replaced();
    } finally {
      this.release();
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.child ? stop(this.child) : Promise.resolve();
    return this.closing;
  }

  private start(args: readonly string[]): void {
    this.launched = this.current.cwd;
    const child = spawn(this.options.command, [...args, "--mode", "rpc"], {
      cwd: this.launched,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new JsonLineDecoder();
    this.child = child;
    // A process replaced by a handoff says nothing more to this conversation.
    const live = () => this.child === child;
    child.stdout.on("data", (chunk: Buffer) => {
      for (const record of decoder.push(chunk)) if (live()) this.receive(record);
    });
    child.stderr.on("data", (chunk: Buffer) => (this.options.stderr ?? this.options.log)?.(chunk.toString()));
    child.stdin.on("error", (error) => {
      if (live()) this.fail(`Pi input closed: ${error.message}`);
    });
    child.once("error", (error) => {
      if (live()) this.fail(`Could not start ${this.options.command}: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      if (!live()) return;
      for (const record of decoder.flush()) this.receive(record);
      this.fail(`Pi exited (${signal ?? code ?? "unknown"})`);
    });
    this.loading = this.loadCommands();
  }

  private async loadCommands(): Promise<void> {
    try {
      const { commands } = await this.rpc({ type: "get_commands" });
      const bridge = this.options.bridge ? (registeredBy(commands, this.options.bridge) ?? null) : null;
      if (bridge === null) this.options.log?.("Pi did not register Pituitary's bridge command\n");
      this.update({ commands, bridge });
    } catch (error) {
      this.options.log?.(`loading Pi commands: ${error instanceof Error ? error.message : String(error)}\n`);
      this.update({ bridge: null });
    }
  }
  private update(patch: Partial<PiWorkspace>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.workspaceListeners) listener();
  }
  /**
   * Runs an operation that may replace the session. From the old runtime's end until the
   * operation answers, what the new runtime reports as it starts is held, so it lands in the
   * view that starts afresh rather than in the one that goes.
   */
  private async replace<T>(operation: () => Promise<T>, replaces: (result: T) => boolean): Promise<T> {
    this.replacing++;
    try {
      const result = await operation();
      if (replaces(result)) {
        // The new runtime loaded the extensions, prompt templates and skills of its project.
        this.loading = this.loadCommands();
        this.replaced();
      }
      return result;
    } finally {
      this.replacing--;
      this.release();
    }
  }
  /** The session moved: nothing projected from the last one's stream carries over. */
  private replaced(): void {
    this.forget();
    for (const listener of this.replaceListeners) listener();
  }
  /** Holds a new runtime's startup report while a replacement is under way; false when none is. */
  private hold(output: Held): boolean {
    if (!this.held) return false;
    // Pi starts each new runtime twice over, so the same report comes twice.
    const key = JSON.stringify(
      output.type === "extension_error"
        ? [output.extensionPath, output.event, output.error]
        : [output.notifyType, output.message],
    );
    if (!this.held.has(key)) this.held.set(key, output);
    return true;
  }
  /** Hands on what was held, in the order it came. */
  private release(): void {
    const held = this.held;
    if (!held || this.replacing > 0) return;
    this.held = undefined;
    for (const output of held.values())
      if (output.type === "extension_error") this.emit(output);
      else this.dispatchUi(output);
  }
  private forget(): void {
    this.streaming = undefined;
    this.running = undefined;
    this.compacting = undefined;
    this.retry = undefined;
    this.queue = undefined;
    this.tools.clear();
  }
  private newId(): string {
    return `pituitary-${++this.nextId}`;
  }
  private drained(): Promise<void> {
    if (!this.pending.size) return Promise.resolve();
    return new Promise((resolve) => this.drainListeners.add(resolve));
  }
  private settle(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!this.pending.size) {
      for (const listener of this.drainListeners) listener();
      this.drainListeners.clear();
    }
    return pending;
  }

  private send<T = unknown>(
    command: { type: string; [key: string]: unknown },
    read: (data: unknown) => T = (data) => data as T,
    id = this.newId(),
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const child = this.child;
    if (!child) return Promise.reject(new Error("Pi's own screen is open"));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (data) => {
          try {
            resolve(read(data));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject,
      });
      child.stdin.write(encodeJsonLine({ ...command, id }), (error) => {
        if (!error) return;
        this.settle(id);
        reject(error);
      });
    });
  }
  private receive(record: string): void {
    let output: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(record);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Expected a record");
      output = scrub(parsed) as Record<string, unknown>;
    } catch {
      this.options.log?.(`Invalid Pi JSON record: ${record}\n`);
      return;
    }
    const type = String(output.type);
    if (type === "response") {
      const pending = this.settle(String(output.id));
      if (!pending) return;
      if (output.success) pending.resolve(output.data);
      else pending.reject(new Error(String(output.error)));
      return;
    }
    if (type === "extension_ui_request") {
      this.extensionUi(output as unknown as PiUiRequest);
      return;
    }
    if (type === "extension_error") {
      this.extensionError(output);
      return;
    }
    if (!EVENTS.has(type)) {
      if (!this.unpresented.has(type)) this.options.log?.(`Pi record not presented: ${type}\n`);
      this.unpresented.add(type);
      return;
    }
    this.emit(output as unknown as SessionEvent);
  }
  /**
   * Bridge replies leave the stream here, before any extension UI could draw them. They and the
   * runtime marks are JSON inside the record's JSON, which `receive` scrubbed only as text, so
   * what they carry is scrubbed once decoded.
   */
  private extensionUi(request: PiUiRequest): void {
    if (request.method === "setStatus" && request.statusKey === BRIDGE_STATUS) {
      const reply = scrub(decodeReply(request.statusText));
      if (reply) this.replies.set(reply.id, reply);
      return;
    }
    if (request.method === "setStatus" && request.statusKey === RUNTIME_STATUS) {
      if (request.statusText === undefined) {
        // The runtime ended; when a replacement ends it, the next one's start is held.
        if (this.replacing > 0) this.held ??= new Map();
      } else {
        // Pi starts a runtime twice over when it replaces a session, with the same mark.
        const mark = scrub(decodeRuntime(request.statusText));
        const { cwd, argumentHints } = this.current;
        if (
          mark &&
          (mark.cwd !== cwd || JSON.stringify(mark.argumentHints) !== JSON.stringify(argumentHints))
        )
          this.update(mark);
      }
    }
    if (request.method === "notify" && this.hold(request)) return;
    this.dispatchUi(request);
  }
  private dispatchUi(request: PiUiRequest): void {
    if (!this.uiListeners.size) this.waitingUi.push(request);
    else for (const listener of this.uiListeners) listener(request);
  }
  /** A failure of the bridge's own command answers its request; any other is the operator's to see. */
  private extensionError(output: Record<string, unknown>): void {
    const extensionPath = String(output.extensionPath ?? "");
    const error = String(output.error ?? "failed");
    if (this.current.bridge && extensionPath === `command:${this.current.bridge}`) {
      this.bridgeFailures.push(error);
      return;
    }
    const failure: Held = {
      type: "extension_error",
      extensionPath,
      event: String(output.event ?? ""),
      error,
    };
    if (!this.hold(failure)) this.emit(failure);
  }
  private emit(event: SessionEvent): void {
    this.project(event);
    const sequence = ++this.sequence;
    for (const listener of this.listeners) listener(event, sequence);
  }
  private project(event: SessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        break;
      case "agent_settled":
        this.running = false;
        this.streaming = undefined;
        // Pi has recorded the commands that ended during the run.
        for (const [id, shell] of this.shells) if (shell.result) this.shells.delete(id);
        break;
      case "compaction_start":
        this.compacting = true;
        break;
      case "compaction_end":
        this.compacting = false;
        break;
      case "queue_update":
        this.queue = { steering: event.steering, followUp: event.followUp };
        break;
      case "auto_retry_start":
        this.retry = {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          at: Date.now() + event.delayMs,
          errorMessage: event.errorMessage,
        };
        break;
      case "auto_retry_end":
        this.retry = undefined;
        break;
      case "message_start": {
        const message = event.message as { role?: string; content?: Block[] };
        if (message.role === "assistant")
          this.streaming = { role: "assistant", content: structuredClone(message.content ?? []) };
        break;
      }
      case "message_end":
        if ((event.message as { role?: string }).role === "assistant") this.streaming = undefined;
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (!this.streaming) break;
        const content = this.streaming.content,
          index = delta.contentIndex;
        switch (delta.type) {
          case "text_start":
            content[index] = { type: "text", text: "" };
            break;
          case "thinking_start":
            content[index] = { type: "thinking", thinking: "" };
            break;
          case "text_delta": {
            const block = content[index] ?? { type: "text", text: "" };
            block.text = (block.text ?? "") + delta.delta;
            content[index] = block;
            break;
          }
          case "thinking_delta": {
            const block = content[index] ?? { type: "thinking", thinking: "" };
            block.thinking = (block.thinking ?? "") + delta.delta;
            content[index] = block;
            break;
          }
          case "text_end":
            content[index] = { type: "text", text: delta.content };
            break;
          case "thinking_end":
            content[index] = { type: "thinking", thinking: delta.content };
            break;
          case "toolcall_start":
            content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} };
            break;
          case "toolcall_end":
            content[index] = delta.toolCall;
            break;
        }
        break;
      }
      case "tool_execution_start":
        this.tools.set(event.toolCallId, { callId: event.toolCallId, name: event.toolName });
        break;
      case "tool_execution_update": {
        const content = event.partialResult.content;
        const output = Array.isArray(content)
          ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
          : String(content ?? "");
        this.tools.set(event.toolCallId, {
          callId: event.toolCallId,
          name: event.toolName,
          output,
          details: event.partialResult.details,
        });
        break;
      }
      case "tool_execution_end":
        this.tools.delete(event.toolCallId);
        break;
      case "bash_execution_update": {
        const shell = event.id === undefined ? undefined : this.shells.get(event.id);
        if (shell)
          this.shells.set(shell.id, {
            ...shell,
            output: (shell.output + event.delta).slice(-SHELL_OUTPUT_LIMIT),
          });
        break;
      }
    }
  }
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = reason;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
    for (const listener of this.drainListeners) listener();
    this.drainListeners.clear();
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
  }
}

/** Pi's name for a command the extension in `file` registers; Pi renames commands that share a name. */
function registeredBy(commands: readonly PiCommandInfo[], file: string): string | undefined {
  const path = resolve(file);
  return commands.find(
    (command) => command.source === "extension" && resolve(command.sourceInfo.path) === path,
  )?.name;
}

/** Ends a Pi process: its input first, then a signal, then a kill if it lingers. */
function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end();
    child.kill("SIGTERM");
  });
}
