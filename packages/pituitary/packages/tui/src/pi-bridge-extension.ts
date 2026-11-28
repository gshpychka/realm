import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
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
      return { sessions: sessions.map(summary) };
    }
    case "rename-session":
      // The open session's manager records the name itself, keeping its own entries in order.
      if (same(call.path)) pi.setSessionName(call.name);
      else SessionManager.open(call.path).appendSessionInfo(call.name);
      return null;
    case "delete-session":
      if (same(call.path)) throw new Error("The session Pi has open cannot be deleted.");
      await remove(call.path);
      return null;
    case "reload":
      await ctx.reload();
      return null;
  }
}

/** A session without the text of every message, which the picker never shows. */
function summary(info: SessionInfo): SessionSummary {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    ...(info.name ? { name: info.name } : {}),
    ...(info.parentSessionPath ? { parent: info.parentSessionPath } : {}),
    modified: info.modified.getTime(),
    messages: info.messageCount,
    first: info.firstMessage,
  };
}

function within(path: string, root: string): boolean {
  const offset = relative(resolve(root), resolve(path));
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/** Deletes a session file as Pi's own picker does: into the trash when a `trash` command can, otherwise for good. */
async function remove(path: string): Promise<void> {
  const trashed = spawnSync("trash", path.startsWith("-") ? ["--", path] : [path], { encoding: "utf8" });
  if (trashed.status === 0 || !existsSync(path)) return;
  await unlink(path);
}
