import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  type SessionEntry,
  type SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_COMMAND,
  BRIDGE_STATUS,
  type BridgeCall,
  BridgeError,
  type BridgeReply,
  decodeCall,
  encodeReply,
  encodeRuntime,
  RUNTIME_STATUS,
  type SessionSummary,
  type TreeKind,
  type TreeNode,
} from "./pi-bridge.ts";

/**
 * Pituitary's side of its bridge into Pi, loaded only for Pituitary's own RPC conversation.
 * Outside RPC mode, as in a handoff to Pi's own screens, it does nothing.
 */
export default function bridge(pi: ExtensionAPI): void {
  // Pi starts each runtime twice over when it replaces a session; the mark says the same both times.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "rpc") ctx.ui.setStatus(RUNTIME_STATUS, encodeRuntime({ cwd: ctx.cwd }));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "rpc") ctx.ui.setStatus(RUNTIME_STATUS, undefined);
  });
  pi.registerCommand(BRIDGE_COMMAND, {
    description: "Pituitary's requests to Pi",
    handler: async (args, ctx) => {
      if (ctx.mode !== "rpc") return;
      // A reload replaces this runtime, after which every getter of `ctx` throws; the reply
      // goes out through the UI captured before it.
      const ui = ctx.ui;
      let call: BridgeCall;
      try {
        call = decodeCall(args);
      } catch (error) {
        // Without an id nothing can name the request, so Pi's extension error rejects it.
        if (!(error instanceof BridgeError) || !error.id) throw error;
        ui.setStatus(BRIDGE_STATUS, encodeReply({ id: error.id, ok: false, error: error.message }));
        return;
      }
      let reply: BridgeReply;
      try {
        reply = { id: call.id, ok: true, result: await answer(pi, call, ctx) };
      } catch (error) {
        reply = { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      ui.setStatus(BRIDGE_STATUS, encodeReply(reply));
    },
  });
}

async function answer(pi: ExtensionAPI, call: BridgeCall, ctx: ExtensionCommandContext): Promise<unknown> {
  const current = ctx.sessionManager.getSessionFile();
  const same = (path: string) => current !== undefined && resolve(path) === resolve(current);
  switch (call.kind) {
    case "sessions": {
      const dir = ctx.sessionManager.getSessionDir();
      // As Pi's own picker: a session directory under Pi's own lists every project's
      // sessions there; a configured one is listed alone.
      const sessions = !call.all
        ? await SessionManager.list(ctx.sessionManager.getCwd(), dir)
        : within(dir, join(getAgentDir(), "sessions"))
          ? await SessionManager.listAll()
          : await SessionManager.listAll(dir);
      return { sessions: await summaries(sessions) };
    }
    case "rename-session":
      // The open session's manager records the name itself, keeping its own entries in order.
      if (same(call.path)) pi.setSessionName(call.name);
      else SessionManager.open(call.path).appendSessionInfo(call.name);
      return null;
    case "delete-session":
      if (same(call.path)) throw new Error("The session Pi has open cannot be deleted.");
      return { trashed: await remove(call.path) };
    case "reload":
      await ctx.reload();
      return null;
    case "tree": {
      const manager = ctx.sessionManager;
      return {
        nodes: manager.getEntries().map((entry) => treeNode(entry, manager.getLabel(entry.id))),
        leaf: manager.getLeafId(),
        skipSummaryPrompt: pi.getSettings().branchSummary?.skipPrompt === true,
      };
    }
    case "navigate": {
      const target = ctx.sessionManager.getEntry(call.entryId);
      if (!target) throw new Error("That point is no longer in this session.");
      const { cancelled } = await ctx.navigateTree(call.entryId, {
        summarize: call.summarize,
        ...(call.instructions ? { customInstructions: call.instructions } : {}),
      });
      // Pi puts the prompt it moved before in its own editor, which RPC has none of.
      return { cancelled, text: cancelled ? "" : writtenAgain(target) };
    }
    case "label":
      pi.setLabel(call.entryId, call.label || undefined);
      return null;
  }
}

/** The most of an entry's text the tree carries: enough for its row, and for the filter to find it by. */
const TREE_TEXT = 400;

/** An entry as the tree picker needs it: what it is, the start of what it says, and its label. */
function treeNode(entry: SessionEntry, label: string | undefined): TreeNode {
  const [kind, text] = described(entry);
  return {
    id: entry.id,
    parent: entry.parentId,
    kind,
    text: text.slice(0, TREE_TEXT),
    ...(label ? { label } : {}),
    ...(entry.type === "compaction" ? { tokens: entry.tokensBefore } : {}),
    at: Date.parse(entry.timestamp),
  };
}

/** What kind of row an entry has in the tree, and what it says. */
function described(entry: SessionEntry): [TreeKind, string] {
  switch (entry.type) {
    case "message": {
      const { message } = entry;
      switch (message.role) {
        case "user":
          return ["user", textOf(message.content)];
        case "assistant":
          return [
            "assistant",
            textOf(message.content) ||
              (message.stopReason === "aborted" ? "aborted" : (message.errorMessage ?? "")),
          ];
        case "toolResult":
          return ["tool", ""];
        case "bashExecution":
          return ["bash", message.command];
        default:
          return ["other", ""];
      }
    }
    case "custom_message":
      return ["custom", `${entry.customType}: ${textOf(entry.content)}`];
    case "compaction":
      return ["compaction", ""];
    case "branch_summary":
      return ["branch", entry.summary];
    default:
      return ["other", ""];
  }
}

/** What Pi puts back in its editor when the session moves to before `entry`; empty when it puts nothing. */
function writtenAgain(entry: SessionEntry): string {
  if (entry.type === "message" && entry.message.role === "user") return textOf(entry.message.content, "");
  if (entry.type === "custom_message") return textOf(entry.content, "");
  return "";
}

/** The text blocks of a message's content, with `separator` between them. */
function textOf(content: unknown, separator = "\n"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join(separator);
}

/** How many session files are read at once to count their prompts. */
const READING = 8;

/** The sessions as the picker shows them, without the text of every message. */
async function summaries(sessions: readonly SessionInfo[]): Promise<SessionSummary[]> {
  const counted: SessionSummary[] = [];
  for (let start = 0; start < sessions.length; start += READING)
    counted.push(...(await Promise.all(sessions.slice(start, start + READING).map(summary))));
  return counted;
}

async function summary(info: SessionInfo): Promise<SessionSummary> {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    ...(info.parentSessionPath ? { parent: info.parentSessionPath } : {}),
    modified: info.modified.getTime(),
    prompts: await promptsIn(info.path),
    first: info.firstMessage,
  };
}

/**
 * The operator's prompts in a session file. Pi's own count takes in every message it stores,
 * the system prompt and each tool result among them, so one exchange would read as three.
 */
async function promptsIn(path: string): Promise<number> {
  let prompts = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line);
      if (isPrompt(entry)) prompts++;
    } catch {
      // Pi skips a line it cannot read too.
    }
  }
  return prompts;
}

function isPrompt(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message")
    return false;
  const message = "message" in entry ? entry.message : undefined;
  return typeof message === "object" && message !== null && "role" in message && message.role === "user";
}

function within(path: string, root: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/**
 * Deletes a session file as Pi's own picker does: into the trash when a `trash` command can,
 * otherwise for good. True when it went to the trash.
 */
async function remove(path: string): Promise<boolean> {
  const trashed = spawnSync("trash", path.startsWith("-") ? ["--", path] : [path], { encoding: "utf8" });
  if (trashed.status === 0 || !existsSync(path)) return true;
  await unlink(path);
  return false;
}
