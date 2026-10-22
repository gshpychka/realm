import { copyFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AgentLink, BRIDGE_COMMAND_PREFIX, type Limits, type RpcSessionState } from "@pituitary/rpc";
import type { ChecklistSpec } from "../components/checklist.tsx";
import type { PickerSpec, PickItem } from "../components/picker.tsx";
import { glyphs } from "../glyphs.ts";
import { usageReport } from "../limits.ts";
import { modelName, modelSource, modelTitle } from "../model-names.ts";
import { tilde } from "../place.ts";
import { counted } from "../plural.ts";
import { providerMark } from "../provider.ts";
import type { SessionController } from "../use-session.ts";
import { assertCarriesOver, busyWith } from "./carry-over.ts";
import { HANDOFF } from "./commands.ts";
import { writeDebug } from "./debug.ts";
import { importSession } from "./import.ts";
import { enabledModels, scopedModels } from "./scoped-models.ts";
import { shareSession } from "./share.ts";
import { treeRows } from "./tree.ts";
import { trust } from "./trust.ts";

/** What a command may do beyond talking to pi. */
export interface CommandContext {
  link: AgentLink;
  session: SessionController;
  pick(spec: PickerSpec): void;
  /** Offers a list to check items from, such as the models ctrl+p cycles. */
  pickMany(spec: ChecklistSpec): void;
  /** Replaces the draft in the editor. */
  setDraft(text: string): void;
  /** Copies text to the operator's clipboard; false when the terminal refuses. */
  copy(text: string): boolean;
  quit(): void;
  /** The key list, as `/hotkeys` prints it. */
  hotkeys(): string;
  /** Hands the terminal to stock pi on this session with `text` in its editor, and carries on after. */
  handoff(text: string): void;
  /** Starts pi afresh on this session, for what pi reads only as it starts, with `notice` once it is up. */
  restart(notice: string): void;
  /** Reads the commands pi offers again, after they may have changed. */
  reloadCommands(): void;
  /** The subscription's usage limits from the latest reply that reported them. */
  limits(): Limits | null;
  /** The rows of the frame on the terminal, as plain text. */
  screen(): string[];
}

/** Runs the built-in command `name`; a failure becomes an error notice. */
export async function runCommand(name: string, args: string, context: CommandContext): Promise<void> {
  try {
    await run(name, args, context);
  } catch (cause) {
    context.session.notify("error", `/${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function run(name: string, args: string, context: CommandContext): Promise<void> {
  const { link, session } = context;
  const state = session.state;
  if (HANDOFF.has(name)) {
    // Stock pi takes over the session only once the RPC agent has stopped, which would cut short anything in progress.
    assertCarriesOver(session, "handing the session to pi");
    context.handoff(`/${name}${args ? ` ${args}` : ""}`);
    return;
  }
  switch (name) {
    case "reload": {
      const busy = busyWith(session);
      if (busy) throw new Error(`${busy}; wait for it to finish before reloading`);
      await bridged(link, "reload");
      await session.refresh();
      context.reloadCommands();
      session.notify("info", "reloaded extensions, skills, prompts, themes, and context files");
      return;
    }
    case "changelog":
      await bridged(link, "changelog");
      return;
    case "tree": {
      const file = state?.sessionFile;
      if (!file) throw new Error("this session is not saved, so it has no tree yet");
      // Read into memory: pi owns the file, and opening it through SessionManager.open can write to it.
      const { SessionManager, parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
      const entries = parseSessionEntries(readFileSync(file, "utf8"));
      const manager = SessionManager.inMemory(process.cwd(), undefined, entries);
      const rows = treeRows(manager.getTree(), manager.getLeafId());
      if (rows.length === 0) throw new Error("the session has nothing to move to yet");
      const move = async (id: string, summarize: boolean) => {
        await bridged(link, "tree", `${id}${summarize ? " summarize" : ""}`);
        await session.refresh({ rebuild: true });
        const text = rows.find((row) => row.id === id)?.editorText;
        if (text) context.setDraft(text);
      };
      context.pick({
        title: "tree · ◆ where the session stands",
        items: rows.map((row) => ({ label: row.label, value: row.id, current: row.current })),
        onPick: (id) =>
          context.pick({
            title: "move there",
            items: [
              { label: "move there", value: "plain" },
              { label: "move there, summarising the branch left behind", value: "summarize" },
            ],
            onPick: (mode) =>
              void move(id, mode === "summarize").catch((cause) => session.notify("error", String(cause))),
          }),
      });
      return;
    }
    case "model": {
      const { models } = await link.call({ type: "get_available_models" });
      const choose = async (value: string) => {
        const [provider = "", ...rest] = value.split("/");
        const model = await link.call({ type: "set_model", provider, modelId: rest.join("/") });
        await session.refresh();
        session.notify("info", `model: ${modelTitle(model)}`);
      };
      const exact = args
        ? models.find((model) => `${model.provider}/${model.id}` === args || model.id === args)
        : undefined;
      if (exact) {
        await choose(`${exact.provider}/${exact.id}`);
        return;
      }
      if (models.length === 0) throw new Error("no models are available; sign in with `pi` first");
      const items = (list: typeof models) =>
        list.map((model) => ({
          label: modelName(model.id),
          detail: modelSource(model),
          icon: providerMark(model.provider),
          value: `${model.provider}/${model.id}`,
          current: model.id === state?.model?.id && model.provider === state?.model?.provider,
        }));
      // The picker opens on the models the operator enabled in pi's settings, as pi's own does.
      const scope = (await enabledModels(models)) ?? [];
      const scoped = scope.flatMap((id) => models.filter((model) => `${model.provider}/${model.id}` === id));
      context.pick({
        title: scoped.length > 0 ? "model · enabled" : "model",
        items: items(scoped.length > 0 ? scoped : models),
        ...(scoped.length > 0
          ? { alternate: { label: "every model", items: async () => items(models) } }
          : {}),
        ...(args ? { query: args } : {}),
        onPick: (value) => void choose(value).catch((cause) => session.notify("error", String(cause))),
      });
      return;
    }
    case "thinking": {
      const { levels } = await link.call({ type: "get_available_thinking_levels" });
      const choose = async (level: string) => {
        const wanted = levels.find((each) => each === level);
        if (!wanted) throw new Error(`no thinking level "${level}"; the model offers ${levels.join(", ")}`);
        await link.call({ type: "set_thinking_level", level: wanted });
        await session.refresh();
      };
      if (args) {
        await choose(args);
        return;
      }
      context.pick({
        title: "thinking level",
        items: levels.map((level) => ({
          label: level,
          value: level,
          current: level === state?.thinkingLevel,
        })),
        onPick: (value) => void choose(value).catch((cause) => session.notify("error", String(cause))),
      });
      return;
    }
    case "new": {
      const { cancelled } = await link.call({ type: "new_session" });
      if (cancelled) session.notify("warning", "an extension kept the session from changing");
      await session.refresh();
      return;
    }
    case "resume": {
      const dir = sessionDir(state);
      const items = await sessionItems(state, dir, false);
      if (items.length === 0) throw new Error("no earlier sessions in this directory");
      context.pick({
        title: "resume",
        items,
        alternate: { label: "every directory", items: () => sessionItems(state, dir, true) },
        onPick: (path) =>
          void (async () => {
            const { cancelled } = await link.call({ type: "switch_session", sessionPath: path });
            if (cancelled) session.notify("warning", "an extension kept the session from changing");
            await session.refresh();
          })().catch((cause) => session.notify("error", String(cause))),
      });
      return;
    }
    case "fork": {
      const { messages } = await link.call({ type: "get_fork_messages" });
      if (messages.length === 0) throw new Error("no prompt to fork from yet");
      context.pick({
        title: "fork from",
        items: messages
          .toReversed()
          .map((message) => ({ label: oneLine(message.text), value: message.entryId })),
        onPick: (entryId) =>
          void (async () => {
            const { text, cancelled } = await link.call({ type: "fork", entryId });
            if (cancelled) session.notify("warning", "an extension kept the session from forking");
            await session.refresh();
            if (!cancelled) context.setDraft(text);
          })().catch((cause) => session.notify("error", String(cause))),
      });
      return;
    }
    case "clone": {
      const { cancelled } = await link.call({ type: "clone" });
      if (cancelled) session.notify("warning", "an extension kept the session from cloning");
      await session.refresh();
      return;
    }
    case "compact": {
      const result = await link.call({ type: "compact", ...(args ? { customInstructions: args } : {}) });
      await session.refresh();
      session.notify(
        "info",
        `compacted from ${glyphs.tokens} ${result.tokensBefore.toLocaleString("en")} tokens`,
      );
      return;
    }
    case "name": {
      if (!args) {
        session.notify(
          "info",
          state?.sessionName
            ? `this session is named "${state.sessionName}"`
            : "this session has no name; /name <name> gives it one",
        );
        return;
      }
      await link.call({ type: "set_session_name", name: args });
      await session.refresh();
      return;
    }
    case "session": {
      const stats = await link.getSessionStats();
      const { input, output, cacheRead, cacheWrite } = stats.tokens;
      const count = (value: number) => value.toLocaleString("en");
      // The share of prompt tokens read from the cache instead of sent afresh.
      const hit =
        input + cacheRead > 0 ? ` · cache hit ${Math.round((cacheRead / (input + cacheRead)) * 100)}%` : "";
      const lines = [
        `file ${stats.sessionFile ? tilde(stats.sessionFile) : "(not saved)"}`,
        `id ${stats.sessionId}`,
        `messages ${stats.userMessages} from you, ${stats.assistantMessages} from pi, ${stats.toolCalls} tool calls`,
        `tokens: input ${count(input)} · output ${count(output)} · cache read ${count(cacheRead)} · cache written ${count(cacheWrite)}${hit}`,
        `cost ${stats.cost.toFixed(4)}`,
      ];
      session.notify("info", lines.join("\n"));
      return;
    }
    case "trust":
      await trust(context);
      return;
    case "scoped-models":
      await scopedModels(context);
      return;
    case "usage":
      session.notify("info", usageReport(context.limits()));
      return;
    case "debug":
      await writeDebug(context);
      return;
    case "import":
      await importSession(args, sessionDir(state), context);
      return;
    case "share":
      await shareSession(context);
      return;
    case "copy": {
      const { text } = await link.call({ type: "get_last_assistant_text" });
      if (!text) throw new Error("there is no reply to copy yet");
      if (!context.copy(text)) throw new Error("the terminal did not accept the clipboard write");
      session.notify("info", "copied the last reply");
      return;
    }
    case "export": {
      if (args.endsWith(".jsonl")) {
        if (!state?.sessionFile) throw new Error("this session is not saved to a file");
        copyFileSync(state.sessionFile, args);
        session.notify("info", `copied the session to ${tilde(args)}`);
        return;
      }
      const { path } = await link.call({ type: "export_html", ...(args ? { outputPath: args } : {}) });
      session.notify("info", `exported to ${tilde(path)}`);
      return;
    }
    case "settings":
      context.pick({
        title: "settings",
        items: settingItems(state),
        onPick: (value) =>
          void applySetting(value, context).catch((cause) => session.notify("error", String(cause))),
      });
      return;
    case "hotkeys":
      session.notify("info", context.hotkeys());
      return;
    case "quit":
      context.quit();
      return;
    default:
      throw new Error("pituitary lists this command but has nothing to run for it");
  }
}

function settingItems(state: RpcSessionState | null): PickItem[] {
  const compaction = state?.autoCompactionEnabled ?? true;
  return [
    {
      label: `auto-compaction: ${compaction ? "on" : "off"}`,
      detail: `turn it ${compaction ? "off" : "on"}`,
      value: `compaction:${!compaction}`,
    },
    { label: "auto-retry: turn on", value: "retry:true" },
    { label: "auto-retry: turn off", value: "retry:false" },
    {
      label: `steering: ${state?.steeringMode ?? "?"}`,
      detail: "deliver queued steering all at once, or one at a time",
      value: `steering:${state?.steeringMode === "all" ? "one-at-a-time" : "all"}`,
    },
    {
      label: `follow-up: ${state?.followUpMode ?? "?"}`,
      detail: "deliver queued follow-ups all at once, or one at a time",
      value: `followUp:${state?.followUpMode === "all" ? "one-at-a-time" : "all"}`,
    },
  ];
}

async function applySetting(value: string, { link, session }: CommandContext): Promise<void> {
  const [setting, to] = value.split(":");
  if (setting === "compaction") await link.call({ type: "set_auto_compaction", enabled: to === "true" });
  if (setting === "retry") await link.call({ type: "set_auto_retry", enabled: to === "true" });
  const mode = to === "all" ? "all" : "one-at-a-time";
  if (setting === "steering") await link.call({ type: "set_steering_mode", mode });
  if (setting === "followUp") await link.call({ type: "set_follow_up_mode", mode });
  await session.refresh();
  session.notify("info", `${setting} set to ${to}`);
}

/**
 * Runs one of the commands pituitary's bridge extension registers, carrying out what RPC
 * has no command for. Checked first, since a name pi does not know goes to the model as a prompt.
 */
async function bridged(link: AgentLink, name: string, args = ""): Promise<void> {
  const full = `${BRIDGE_COMMAND_PREFIX}${name}`;
  const { commands } = await link.call({ type: "get_commands" });
  if (!commands.some((command) => command.name === full)) {
    throw new Error("this needs pituitary's bridge extension, which this pi has not loaded");
  }
  await link.prompt(`/${full}${args ? ` ${args}` : ""}`);
}

/** Where pi keeps this session's siblings: beside the session file, wherever pi put it. */
function sessionDir(state: RpcSessionState | null): string | undefined {
  if (state?.sessionFile) return dirname(state.sessionFile);
  return process.env.PI_CODING_AGENT_SESSION_DIR;
}

async function sessionItems(
  state: RpcSessionState | null,
  dir: string | undefined,
  all: boolean,
): Promise<PickItem[]> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessions = all ? await SessionManager.listAll(dir) : await SessionManager.list(process.cwd(), dir);
  return sessions.map((info) => ({
    label: info.name || oneLine(info.firstMessage) || "(empty)",
    detail: `${ago(info.modified)} · ${info.messageCount} messages${all && info.cwd ? ` · ${tilde(info.cwd)}` : ""}`,
    value: info.path,
    current: info.path === state?.sessionFile,
  }));
}

function oneLine(text: string, width = 72): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

/** How long ago `date` was, in the largest whole unit. */
export function ago(date: Date, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const unit = (count: number, name: string) => `${counted(count, name)} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}
