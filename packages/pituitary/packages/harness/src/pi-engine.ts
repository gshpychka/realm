import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSnapshot,
  PiEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
} from "@pituitary/rpc";
import type { WorkerEngine, WorkerEngineContext } from "./protocol.ts";

type UiPayload<T = RpcExtensionUIRequest> = T extends RpcExtensionUIRequest ? Omit<T, "id" | "type"> : never;

/** The native engine does not discover the operator's ambient packages or extensions. */
export async function createNativeEngine(context: WorkerEngineContext): Promise<WorkerEngine> {
  const agentDirectory = join(context.stateDirectory, "agent");
  const sessionsDirectory = join(context.stateDirectory, "sessions");
  mkdirSync(agentDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(sessionsDirectory, { recursive: true, mode: 0o700 });
  const configDirectory = context.configDirectory ?? process.env.PITUITARY_CONFIG_DIRECTORY ?? getAgentDir();
  const defaults = SettingsManager.create(context.cwd, configDirectory, { projectTrusted: false });
  // Read model preferences, not ambient packages, extensions, shell hooks or project trust.
  const settings = SettingsManager.inMemory({
    cacheWarming: "off",
    defaultProjectTrust: "never",
    defaultProvider: defaults.getDefaultProvider(),
    defaultModel: defaults.getDefaultModel(),
    defaultThinkingLevel: defaults.getDefaultThinkingLevel(),
    modelThinkingLevels: defaults.getAllModelThinkingLevels(),
  });
  const models = await ModelRuntime.create({
    authPath: context.authFile ?? process.env.PITUITARY_AUTH_FILE ?? join(configDirectory, "auth.json"),
    modelsPath: join(configDirectory, "models.json"),
    modelsStorePath: join(agentDirectory, "models-store.json"),
    allowModelNetwork: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: context.cwd,
    agentDir: agentDirectory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: context.instructions ? [context.instructions] : [],
  });
  await loader.reload();
  let model: AgentSession["model"];
  if (context.model) {
    const slash = context.model.indexOf("/");
    if (slash < 1) throw new Error("worker model must be provider/model");
    model = models.getModel(context.model.slice(0, slash), context.model.slice(slash + 1));
    if (!model) throw new Error(`unknown worker model: ${context.model}`);
  }
  const sessionPath = context.sessionFile ?? join(sessionsDirectory, "session.jsonl");
  if (context.sessionFile && !existsSync(sessionPath))
    throw new Error("the saved native session is missing; explicit recovery is required");
  // Opening an explicit empty file makes Pi persist even before the first model reply.
  // Otherwise accepted session names, shell results and initial prompts can exist only in memory.
  if (!existsSync(sessionPath)) closeSync(openSync(sessionPath, "wx", 0o600));
  const manager = SessionManager.open(sessionPath, sessionsDirectory, context.cwd);
  if (context.sessionId && manager.getSessionId() !== context.sessionId)
    throw new Error("the saved native conversation identity changed; explicit recovery is required");
  const { session } = await createAgentSession({
    cwd: context.cwd,
    agentDir: agentDirectory,
    sessionManager: manager,
    modelRuntime: models,
    settingsManager: settings,
    resourceLoader: loader,
    model,
    tools: context.role?.tools,
  });
  const dialogs = new Map<string, (response: RpcExtensionUIResponse) => void>();
  const request = (payload: UiPayload): string => {
    const id = randomUUID();
    context.onUiRequest({ type: "extension_ui_request", id, ...payload } as RpcExtensionUIRequest);
    return id;
  };
  // Native managed extensions are disabled for now; standard dialogs still have a real input owner.
  const themeColors =
    "accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode".split(
      " ",
    );
  const theme = new Theme(
    Object.fromEntries(themeColors.map((color) => [color, "#c0c0c0"])) as ConstructorParameters<
      typeof Theme
    >[0],
    {
      selectedBg: "#303030",
      searchMatchBg: "#303030",
      userMessageBg: "#303030",
      customMessageBg: "#303030",
      toolPendingBg: "#303030",
      toolSuccessBg: "#303030",
      toolErrorBg: "#303030",
    },
    "truecolor",
  );
  const ask = <T>(
    payload: UiPayload,
    fallback: T,
    parse: (response: RpcExtensionUIResponse) => T,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> => {
    if (options?.signal?.aborted) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const id = randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: T) => {
        dialogs.delete(id);
        context.onUiClose(id);
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(fallback);
      dialogs.set(id, (response) => finish(parse(response)));
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.timeout) timer = setTimeout(abort, options.timeout);
      context.onUiRequest({ type: "extension_ui_request", id, ...payload } as RpcExtensionUIRequest);
    });
  };
  const ui: ExtensionUIContext = {
    select: (title, options, opts) =>
      ask(
        { method: "select", title, options, timeout: opts?.timeout },
        undefined,
        (r) => ("value" in r && !("cancelled" in r && r.cancelled) ? r.value : undefined),
        opts,
      ),
    confirm: (title, message, opts) =>
      ask(
        { method: "confirm", title, message, timeout: opts?.timeout },
        false,
        (r) => "confirmed" in r && r.confirmed === true,
        opts,
      ),
    input: (title, placeholder, opts) =>
      ask(
        { method: "input", title, placeholder, timeout: opts?.timeout },
        undefined,
        (r) => ("value" in r && !("cancelled" in r && r.cancelled) ? r.value : undefined),
        opts,
      ),
    editor: (title, prefill) =>
      ask({ method: "editor", title, prefill }, undefined, (r) => ("value" in r ? r.value : undefined)),
    notify: (message, notifyType) => {
      request({ method: "notify", message, notifyType });
    },
    setStatus: (statusKey, statusText) => {
      request({ method: "setStatus", statusKey, statusText });
    },
    setWidget: (
      widgetKey: string,
      content: unknown,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => {
      if (typeof content === "function") throw new Error("component widgets require the legacy Pi frontend");
      request({
        method: "setWidget",
        widgetKey,
        widgetLines: content as string[] | undefined,
        widgetPlacement: options?.placement,
      });
    },
    setTitle: (title) => {
      request({ method: "setTitle", title });
    },
    setEditorText: (text) => {
      request({ method: "set_editor_text", text });
    },
    pasteToEditor: (text) => {
      request({ method: "set_editor_text", text });
    },
    getEditorText: () => "",
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    custom: async () => {
      throw new Error("custom extension screens require the legacy Pi frontend");
    },
    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "theme switching is not available in managed workers" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  await session.bindExtensions({
    uiContext: ui,
    mode: "rpc",
    onError: (error) => context.onEvent({ type: "extension_error", ...error }),
  });
  const unsubscribe = session.subscribe((event) => context.onEvent(wireEvent(event)));
  const active = new Set<Promise<unknown>>();
  return {
    snapshot: () => snapshotNativeSession(session),
    call: async (command) => {
      if (context.role) {
        if (command.type === "set_model" || command.type === "cycle_model")
          throw new Error("the model is declared by the agent role; start a new attempt to change it");
        if (command.type === "bash" && !context.role.tools.includes("bash"))
          throw new Error("the agent role does not enable the bash tool");
      }
      const operation = nativeCall(session, command, context.onEvent);
      active.add(operation);
      try {
        return await operation;
      } finally {
        active.delete(operation);
      }
    },
    respond: (response) => {
      dialogs.get(response.id)?.(response);
    },
    close: async () => {
      for (const [id, answer] of dialogs) answer({ type: "extension_ui_response", id, cancelled: true });
      unsubscribe();
      session.abortBash();
      try {
        await session.abort();
      } finally {
        session.dispose();
        await Promise.allSettled([...active]);
      }
    },
  };
}

/** One synchronous read captures Pi's finalized context, live reply, tools and queues together. */
export function snapshotNativeSession(session: AgentSession): Omit<AgentSnapshot, "sequence"> {
  return structuredClone({
    state: sessionState(session),
    messages: session.messages,
    streamingMessage: session.state.streamingMessage,
    pendingToolCalls: [...session.state.pendingToolCalls],
    queue: { steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() },
  });
}

function sessionState(session: AgentSession): RpcSessionState {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  };
}

function wireEvent(event: AgentSessionEvent): PiEvent {
  if (event.type !== "message_update") return event;
  if (event.message.role !== "assistant")
    throw new Error("Pi emitted an update without an assistant message");
  const { partial: _partial, ...delta } =
    event.assistantMessageEvent as typeof event.assistantMessageEvent & { partial?: unknown };
  if (event.assistantMessageEvent.type === "toolcall_start") {
    const tool = event.assistantMessageEvent.partial.content[event.assistantMessageEvent.contentIndex];
    if (tool?.type !== "toolCall") throw new Error("Pi emitted a tool call without its identity");
    return {
      type: "message_update",
      usage: event.message.usage,
      assistantMessageEvent: { ...delta, id: tool.id, toolName: tool.name },
    } as PiEvent;
  }
  return { type: "message_update", usage: event.message.usage, assistantMessageEvent: delta } as PiEvent;
}

async function nativeCall(
  session: AgentSession,
  command: RpcCommand,
  onEvent: (event: PiEvent) => void,
): Promise<unknown> {
  switch (command.type) {
    case "prompt":
      return new Promise<void>((resolve, reject) => {
        let accepted = false;
        void session
          .prompt(command.message, {
            images: command.images,
            streamingBehavior: command.streamingBehavior,
            source: "rpc",
            preflightResult: (success) => {
              if (success) {
                accepted = true;
                resolve();
              }
            },
          })
          .then(resolve, (cause) => {
            if (!accepted) reject(cause);
            else
              onEvent({
                type: "extension_error",
                extensionPath: "worker",
                event: "prompt",
                error: describe(cause),
              });
          });
      });
    case "steer":
      return session.steer(command.message, command.images, { source: "rpc" });
    case "follow_up":
      return session.followUp(command.message, command.images, { source: "rpc" });
    case "abort":
      return session.abort();
    case "clear_queue":
      return session.clearQueue();
    case "get_state":
      return sessionState(session);
    case "get_messages":
      return { messages: session.messages };
    case "get_session_stats":
      return session.getSessionStats();
    case "get_available_models":
      return { models: session.modelRuntime.getAvailableSnapshot() };
    case "set_model": {
      const model = session.modelRuntime.getModel(command.provider, command.modelId);
      if (!model) throw new Error(`model not found: ${command.provider}/${command.modelId}`);
      await session.setModel(model);
      return model;
    }
    case "cycle_model":
      return (await session.cycleModel()) ?? null;
    case "set_thinking_level":
      return session.setThinkingLevel(command.level);
    case "cycle_thinking_level":
      return { level: session.cycleThinkingLevel() };
    case "get_available_thinking_levels":
      return { levels: session.getAvailableThinkingLevels() };
    case "set_steering_mode":
      return session.setSteeringMode(command.mode);
    case "set_follow_up_mode":
      return session.setFollowUpMode(command.mode);
    case "set_auto_compaction":
      return session.setAutoCompactionEnabled(command.enabled);
    case "set_auto_retry":
      return session.setAutoRetryEnabled(command.enabled);
    case "abort_retry":
      return session.abortRetry();
    case "bash":
      return session.executeBash(command.command, undefined, {
        excludeFromContext: command.excludeFromContext,
        id: command.id,
      });
    case "abort_bash":
      return session.abortBash();
    case "compact":
      return session.compact(command.customInstructions);
    case "get_entries": {
      let entries = session.sessionManager.getEntries();
      if (command.since !== undefined) {
        const index = entries.findIndex((entry) => entry.id === command.since);
        if (index < 0) throw new Error(`entry not found: ${command.since}`);
        entries = entries.slice(index + 1);
      }
      return { entries, leafId: session.sessionManager.getLeafId() };
    }
    case "get_tree":
      return { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() };
    case "get_fork_messages":
      return { messages: session.getUserMessagesForForking() };
    case "get_last_assistant_text":
      return { text: session.getLastAssistantText() };
    case "set_session_name": {
      if (!command.name.trim()) throw new Error("session name cannot be empty");
      session.setSessionName(command.name.trim());
      return;
    }
    case "get_commands":
      return { commands: [] };
    case "new_session":
    case "switch_session":
    case "fork":
    case "clone":
      throw new Error(
        "managed runs keep one conversation; start another with pituitary run. Session branching must be mediated by the runtime",
      );
    case "export_html":
      return { path: await session.exportToHtml(command.outputPath) };
    default:
      throw new Error(`unsupported worker command: ${(command as RpcCommand).type}`);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
