#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
/**
 * A pi RPC agent whose replies are scripted, so the UI can be driven without a
 * model provider, network access, or credentials.
 *
 * FAKE_PI_SCENARIO selects the script; FAKE_PI_DELAY_MS spaces the events out to
 * make streaming observable.
 */
import {
  abortedRun,
  encodeJsonLine,
  fakeModels,
  fakeSessionState,
  JsonLineDecoder,
  type PiEvent,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type RpcResponse,
  type RpcSessionState,
} from "@pituitary/rpc";
import { getScenario } from "../scenarios/index.ts";
import { bridgeClient } from "./bridge.ts";
import type { Beat } from "./types.ts";

const scenario = getScenario(process.env.FAKE_PI_SCENARIO ?? "hello");
const delayMs = Number(process.env.FAKE_PI_DELAY_MS ?? "0");
const toBridge = bridgeClient();
const history: unknown[] = [...(scenario.history ?? [])];
const models = scenario.models ?? fakeModels;
const state = { ...fakeSessionState, model: models[0], messageCount: history.length, ...scenario.state };

let generation = 0;
let sessions = 0;
let running = false;
const steering: string[] = [];
const followUp: string[] = [];

const THINKING: RpcSessionState["thinkingLevel"][] = ["off", "minimal", "low", "medium", "high"];

/** Commands the operator's extensions, prompts, and skills add, as `get_commands` lists them. */
const COMMANDS = [
  {
    name: "review",
    description: "Review the working tree",
    source: "prompt",
    sourceInfo: { path: "", source: "inline", scope: "temporary", origin: "top-level" },
  },
  {
    name: "plan",
    description: "Enter plan mode",
    source: "extension",
    sourceInfo: { path: "", source: "inline", scope: "temporary", origin: "top-level" },
  },
];

function isExtensionCommand(message: string): boolean {
  const name = /^\/(\S+)/.exec(message)?.[1];
  const commands = (scenario.commands ?? COMMANDS) as { name: string; source: string }[];
  return commands.some((command) => command.name === name && command.source === "extension");
}

/** Swaps in another session, as pi does for new, switch, fork, and clone. */
function replaceSession(messages: unknown[], file?: string, fresh = true): void {
  history.splice(0, history.length, ...messages);
  state.messageCount = history.length;
  if (fresh) state.sessionId = `fake-session-${++sessions}`;
  if (file) state.sessionFile = file;
}

/** The messages a stored session file holds. */
function messagesIn(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

/** Command records held back while a run is in progress, as pi holds them. */
const deferred: unknown[] = [];
/** The command the operator is running, which `abort_bash` cancels. */
let shell: { cancel(): void } | null = null;

function record(...messages: unknown[]): void {
  history.push(...messages);
  state.messageCount = history.length;
}

/** Streams a command's output line by line, then answers with its result. */
async function runBash(id: string | undefined, command: string, excluded: boolean): Promise<void> {
  let cancelled = false;
  shell = { cancel: () => (cancelled = true) };
  const lines = (scenario.bash?.(command) ?? [`ran: ${command}`]).map((line) => `${line}\n`);
  let output = "";
  for (const line of lines) {
    if (delayMs > 0) await sleep(delayMs);
    if (cancelled) break;
    output += line;
    write({ type: "bash_execution_update", id, delta: line } as PiEvent);
  }
  shell = null;
  const result = { output, exitCode: cancelled ? undefined : 0, cancelled, truncated: false };
  const message = { role: "bashExecution", command, ...result, excludeFromContext: excluded, timestamp: 0 };
  if (running) deferred.push(message);
  else record(message);
  ok(id, "bash", result);
}

/** Dialogs the script is waiting on, by request id. */
const awaiting = new Map<string, (response: RpcExtensionUIResponse) => void>();

/** Typed so a scripted record that pi could not emit fails the typecheck. */
function write(out: PiEvent | RpcResponse | RpcExtensionUIRequest): void {
  if (out.type === "message_end") record(out.message);
  // pi drops a failed reply from the session when it retries.
  if (out.type === "auto_retry_start") {
    const last = history.findLastIndex((message) => (message as { role?: string }).role === "assistant");
    if (last !== -1) history.splice(last, 1);
    state.messageCount = history.length;
  }
  process.stdout.write(encodeJsonLine(out));
}

function ok(id: string | undefined, command: string, data?: unknown): void {
  write({
    type: "response",
    command,
    success: true,
    ...(id ? { id } : {}),
    ...(data === undefined ? {} : { data }),
  } as RpcResponse);
}

function fail(id: string | undefined, command: string, error: string): void {
  write({ type: "response", command, success: false, error, ...(id ? { id } : {}) } as RpcResponse);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function play(beats: Beat[], mine: number): Promise<void> {
  for (const beat of beats) {
    if (generation !== mine) return;
    if (delayMs > 0) await sleep(delayMs);
    if (generation !== mine) return;
    if ("ui" in beat) write(beat.ui);
    else if ("ask" in beat) {
      const reply = new Promise<RpcExtensionUIResponse>((resolve) => awaiting.set(beat.ask.id, resolve));
      write(beat.ask);
      await play(beat.answered(await reply), mine);
    } else if ("exit" in beat) process.exit(beat.exit);
    else if ("limits" in beat) toBridge({ type: "limits", headers: beat.limits });
    else if ("session" in beat) {
      history.splice(0, history.length, ...beat.session);
      state.messageCount = history.length;
      state.sessionId = `fake-session-${++sessions}`;
    } else {
      if (beat.type === "agent_start") running = true;
      if (beat.type === "agent_settled") {
        running = false;
        record(...deferred.splice(0));
      }
      write(beat);
    }
  }
}

async function emit(beats: Beat[], mine: number): Promise<void> {
  running = true;
  await play(beats, mine);
  running = false;
  if (generation === mine && (steering.length > 0 || followUp.length > 0)) {
    steering.length = 0;
    followUp.length = 0;
    write({ type: "queue_update", steering: [], followUp: [] });
  }
}

function handle(command: RpcCommand & { id?: string }): void {
  const { id } = command;
  switch (command.type) {
    case "prompt": {
      if (running && !command.streamingBehavior) {
        fail(id, "prompt", "agent is streaming; specify streamingBehavior");
        return;
      }
      const refusal = scenario.refuse?.(command.message);
      if (refusal) {
        fail(id, "prompt", refusal);
        return;
      }
      if (running && command.streamingBehavior) {
        const queue = command.streamingBehavior === "steer" ? steering : followUp;
        queue.push(command.message);
        ok(id, "prompt");
        write({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
        return;
      }
      const mine = ++generation;
      // pi answers an extension command once its handler has run, and any other prompt,
      // prompt templates and skills included, once it is accepted.
      if (isExtensionCommand(command.message)) {
        void emit(scenario.run(command.message), mine).then(() => ok(id, "prompt"));
        return;
      }
      ok(id, "prompt");
      void emit(scenario.run(command.message), mine);
      return;
    }
    case "steer":
    case "follow_up": {
      const queue = command.type === "steer" ? steering : followUp;
      queue.push(command.message);
      ok(id, command.type);
      write({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
      return;
    }
    case "abort": {
      const wasRunning = running;
      generation++;
      running = false;
      awaiting.clear();
      // pi ends the reply and the run only when one is in progress, answers once the run has
      // settled, and keeps the queue.
      if (wasRunning) for (const event of abortedRun()) write(event);
      ok(id, "abort");
      return;
    }
    case "get_state":
      ok(id, "get_state", { ...state, isStreaming: running });
      return;
    case "get_messages":
      ok(id, "get_messages", { messages: history });
      return;
    case "get_commands":
      ok(id, "get_commands", { commands: scenario.commands ?? COMMANDS });
      return;
    case "get_session_stats": {
      const turns = history.filter((message) => (message as { role?: string }).role === "assistant").length;
      const percent = scenario.context ?? Math.min(99, turns * 7);
      const window = 200_000;
      ok(id, "get_session_stats", {
        sessionFile: undefined,
        sessionId: state.sessionId,
        userMessages: history.filter((message) => (message as { role?: string }).role === "user").length,
        assistantMessages: turns,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: history.length,
        tokens: {
          input: turns * 1200,
          output: turns * 340,
          cacheRead: turns * 4000,
          cacheWrite: turns * 500,
          total: turns * 6040,
        },
        cost: turns * 0.0123,
        contextUsage: { tokens: (percent / 100) * window, contextWindow: window, percent },
      });
      return;
    }
    case "bash":
      void runBash(id, command.command, command.excludeFromContext ?? false);
      return;
    case "get_available_models":
      ok(id, command.type, { models });
      return;
    case "set_model": {
      const model = models.find((each) => each.provider === command.provider && each.id === command.modelId);
      if (!model) {
        fail(id, command.type, `unknown model ${command.provider}/${command.modelId}`);
        return;
      }
      state.model = model;
      ok(id, command.type, model);
      return;
    }
    case "cycle_model": {
      const next = models[(models.findIndex((each) => each.id === state.model?.id) + 1) % models.length];
      if (next) state.model = next;
      ok(
        id,
        command.type,
        next ? { model: next, thinkingLevel: state.thinkingLevel, isScoped: false } : null,
      );
      return;
    }
    case "get_available_thinking_levels":
      ok(id, command.type, { levels: THINKING });
      return;
    case "set_thinking_level":
      state.thinkingLevel = command.level;
      ok(id, command.type);
      return;
    case "cycle_thinking_level": {
      const level = THINKING[(THINKING.indexOf(state.thinkingLevel) + 1) % THINKING.length] ?? "off";
      state.thinkingLevel = level;
      ok(id, command.type, { level });
      return;
    }
    case "new_session":
      replaceSession([]);
      ok(id, command.type, { cancelled: false });
      return;
    case "switch_session":
      try {
        replaceSession(messagesIn(command.sessionPath), command.sessionPath);
        ok(id, command.type, { cancelled: false });
      } catch (error) {
        fail(id, command.type, String(error));
      }
      return;
    case "get_fork_messages":
      ok(id, command.type, {
        messages: history.flatMap((message, index) => {
          const { role, content } = message as { role?: string; content?: unknown };
          return role === "user"
            ? [{ entryId: `m${index}`, text: typeof content === "string" ? content : "" }]
            : [];
        }),
      });
      return;
    case "fork": {
      const index = Number(command.entryId.slice(1));
      const message = history[index] as { content?: unknown } | undefined;
      if (!message) {
        fail(id, command.type, `unknown entry ${command.entryId}`);
        return;
      }
      replaceSession(history.slice(0, index));
      ok(id, command.type, {
        text: typeof message.content === "string" ? message.content : "",
        cancelled: false,
      });
      return;
    }
    case "clone":
      replaceSession([...history]);
      ok(id, command.type, { cancelled: false });
      return;
    case "compact": {
      const summary = command.customInstructions
        ? `Summary (${command.customInstructions}).`
        : "Summary of the session so far.";
      const result = { summary, firstKeptEntryId: "m0", tokensBefore: 42_000 };
      write({ type: "compaction_start", reason: "manual" });
      replaceSession(
        [{ role: "compactionSummary", summary, tokensBefore: 42_000, timestamp: 0 }],
        undefined,
        false,
      );
      write({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });
      ok(id, command.type, result);
      return;
    }
    case "set_session_name":
      state.sessionName = command.name;
      ok(id, command.type);
      return;
    case "export_html":
      if (command.outputPath) {
        writeFileSync(
          command.outputPath,
          `<html><body>${history.length} messages from ${state.sessionId}</body></html>\n`,
        );
      }
      ok(id, command.type, { path: command.outputPath ?? "/tmp/pi-session.html" });
      return;
    case "get_last_assistant_text": {
      const last = [...history]
        .reverse()
        .find((message) => (message as { role?: string }).role === "assistant") as
        | { content?: { type?: string; text?: string }[] }
        | undefined;
      const text = last?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      ok(id, command.type, { text: text || null });
      return;
    }
    case "set_auto_compaction":
      state.autoCompactionEnabled = command.enabled;
      ok(id, command.type);
      return;
    case "set_auto_retry":
    case "set_steering_mode":
    case "set_follow_up_mode":
      ok(id, command.type);
      return;
    case "abort_retry":
      ok(id, "abort_retry");
      write({ type: "auto_retry_end", success: false, attempt: 1, finalError: "retry cancelled" });
      write({ type: "agent_end", messages: [], willRetry: false });
      write({ type: "agent_settled" });
      generation++;
      running = false;
      return;
    case "abort_bash":
      shell?.cancel();
      ok(id, "abort_bash");
      return;
    case "clear_queue": {
      const taken = { steering: steering.splice(0), followUp: followUp.splice(0) };
      ok(id, "clear_queue", taken);
      write({ type: "queue_update", steering: [], followUp: [] });
      return;
    }
    default:
      fail(id, command.type, `fake agent does not implement "${command.type}"`);
  }
}

const decoder = new JsonLineDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  for (const record of decoder.push(chunk)) {
    try {
      const parsed = JSON.parse(record) as (RpcCommand & { id?: string }) | RpcExtensionUIResponse;
      if (parsed.type === "extension_ui_response") {
        awaiting.get(parsed.id)?.(parsed);
        awaiting.delete(parsed.id);
        continue;
      }
      handle(parsed);
    } catch (error) {
      process.stderr.write(`fake-pi: ${String(error)}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
