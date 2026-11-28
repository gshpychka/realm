import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BRIDGE_COMMAND, BRIDGE_STATUS, type BridgeCall, encodeCall, RUNTIME_STATUS } from "./pi-bridge.ts";
import bridge from "./pi-bridge-extension.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pituitary-bridge-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A saved session in `project` whose operator sent `prompts`, each answered. */
function saved(project: string, prompts: string[]): SessionManager {
  const manager = SessionManager.create(join(root, project), join(root, "sessions"));
  for (const [index, prompt] of prompts.entries()) {
    manager.appendMessage({ role: "user", content: prompt, timestamp: index });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Reply to: ${prompt}` }],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: index,
    });
  }
  return manager;
}

/** The bridge loaded into a stand-in for Pi, its command run in `mode` on the open session `open`. */
function load(open: SessionManager, mode: "rpc" | "interactive" = "rpc") {
  const statuses: [string, string | undefined][] = [];
  const named: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: typeof command }) => {
      expect(name).toBe(BRIDGE_COMMAND);
      command = options.handler;
    },
    setSessionName: (name: string) => named.push(name),
  } as unknown as ExtensionAPI;
  bridge(pi);
  const ctx = {
    mode,
    cwd: open.getCwd(),
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
    sessionManager: open,
    reload: async () => {},
  } as unknown as ExtensionCommandContext;
  let next = 0;
  /** Runs one request and returns the reply it set. */
  const ask = async (request: Record<string, unknown>) => {
    const id = `${++next}`;
    await command?.(encodeCall({ ...request, id } as BridgeCall), ctx);
    const reply = statuses.findLast(([key]) => key === BRIDGE_STATUS)?.[1];
    return reply ? JSON.parse(reply) : undefined;
  };
  return {
    ask,
    statuses,
    named,
    start: () => handlers.get("session_start")?.({}, ctx),
    stop: () => handlers.get("session_shutdown")?.({}, ctx),
  };
}

test("this project's sessions are listed with the prompts each holds, every project's with all", async () => {
  const open = saved("app", ["first", "second"]);
  const other = saved("app", ["only"]);
  saved("elsewhere", ["far away"]);
  const { ask } = load(open);
  const listed = await ask({ kind: "sessions", all: false });
  expect(listed.ok).toBe(true);
  const byPath = new Map(listed.result.sessions.map((session: { path: string }) => [session.path, session]));
  expect(byPath.size).toBe(2);
  // Pi counts the reply too; the list counts what the operator sent.
  expect(byPath.get(open.getSessionFile())).toMatchObject({
    prompts: 2,
    first: "first",
    cwd: join(root, "app"),
  });
  expect(byPath.get(other.getSessionFile())).toMatchObject({ prompts: 1, first: "only" });
  expect(byPath.get(open.getSessionFile())).not.toHaveProperty("allMessagesText");
  expect((await ask({ kind: "sessions", all: true })).result.sessions).toHaveLength(3);
});

test("renaming names the open session through Pi and another one in its file", async () => {
  const open = saved("app", ["first"]);
  const other = saved("app", ["only"]);
  const { ask, named } = load(open);
  expect(await ask({ kind: "rename-session", path: open.getSessionFile(), name: "Open one" })).toMatchObject({
    ok: true,
  });
  expect(named).toEqual(["Open one"]);
  await ask({ kind: "rename-session", path: other.getSessionFile(), name: "Planning" });
  expect(SessionManager.open(other.getSessionFile() as string).getSessionName()).toBe("Planning");
});

test("deleting refuses the open session and says whether another went to the trash", async () => {
  const open = saved("app", ["first"]);
  const other = saved("app", ["only"]);
  const { ask } = load(open);
  expect(await ask({ kind: "delete-session", path: open.getSessionFile() })).toMatchObject({
    ok: false,
    error: "The session Pi has open cannot be deleted.",
  });
  expect(existsSync(open.getSessionFile() as string)).toBe(true);
  // Without a trash command on the path the file is deleted for good.
  const path = process.env.PATH;
  process.env.PATH = root;
  try {
    expect(await ask({ kind: "delete-session", path: other.getSessionFile() })).toMatchObject({
      ok: true,
      result: { trashed: false },
    });
  } finally {
    process.env.PATH = path;
  }
  expect(existsSync(other.getSessionFile() as string)).toBe(false);
});

test("a malformed request is answered by its id; outside RPC the bridge does nothing", async () => {
  const open = saved("app", ["first"]);
  const { ask, statuses, start, stop } = load(open);
  expect(await ask({ kind: "sessions" })).toMatchObject({ ok: false, error: "sessions needs `all`." });
  start();
  stop();
  expect(statuses.filter(([key]) => key === RUNTIME_STATUS)).toEqual([
    [RUNTIME_STATUS, JSON.stringify({ cwd: join(root, "app") })],
    [RUNTIME_STATUS, undefined],
  ]);
  const elsewhere = load(open, "interactive");
  expect(await elsewhere.ask({ kind: "sessions", all: false })).toBeUndefined();
  elsewhere.start();
  expect(elsewhere.statuses).toEqual([]);
});
