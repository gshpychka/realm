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

/**
 * The bridge loaded into a stand-in for Pi, its command run in `mode` on the open session `open`.
 * A move through the tree is cancelled when `cancel` says so.
 */
function load(
  open: SessionManager,
  mode: "rpc" | "interactive" = "rpc",
  { skipPrompt, cancel = false }: { skipPrompt?: boolean; cancel?: boolean } = {},
) {
  const statuses: [string, string | undefined][] = [];
  const named: string[] = [];
  const labels: [string, string | undefined][] = [];
  const moves: [entryId: unknown, options: unknown][] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
    registerCommand: (name: string, options: { handler: typeof command }) => {
      expect(name).toBe(BRIDGE_COMMAND);
      command = options.handler;
    },
    setSessionName: (name: string) => named.push(name),
    setLabel: (entryId: string, label: string | undefined) => labels.push([entryId, label]),
    getSettings: () => (skipPrompt === undefined ? {} : { branchSummary: { skipPrompt } }),
  } as unknown as ExtensionAPI;
  bridge(pi);
  const ctx = {
    mode,
    cwd: open.getCwd(),
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
    sessionManager: open,
    reload: async () => {},
    navigateTree: async (entryId: string, options: unknown) => {
      moves.push([entryId, options]);
      return { cancelled: cancel };
    },
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
    labels,
    moves,
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

test("the tree carries every entry, lean, with labels, the leaf, and whether Pi asks to summarize", async () => {
  const open = saved("app", ["first", "second"]);
  const [, firstReply, second] = open.getEntries();
  open.appendLabelChange(second?.id as string, "checkpoint");
  // Going back before the second prompt and asking again forks the tree there.
  open.branch(firstReply?.id as string);
  open.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "third" },
      { type: "image", data: "", mimeType: "image/png" },
    ],
    timestamp: 9,
  });
  const { ask } = load(open, "rpc", { skipPrompt: true });
  const { result } = await ask({ kind: "tree" });
  expect(result.leaf).toBe(open.getLeafId());
  expect(result.skipSummaryPrompt).toBe(true);
  const kinds = result.nodes.map((node: { kind: string; text: string }) => [node.kind, node.text]);
  expect(kinds).toEqual([
    ["user", "first"],
    ["assistant", "Reply to: first"],
    ["user", "second"],
    ["assistant", "Reply to: second"],
    // Pi's own bookkeeping is in the tree, without words.
    ["other", ""],
    ["user", "third"],
  ]);
  expect(result.nodes[2]).toMatchObject({ label: "checkpoint", parent: firstReply?.id });
  expect(result.nodes[5]).toMatchObject({ parent: firstReply?.id, at: expect.any(Number) });
  expect((await load(open).ask({ kind: "tree" })).result.skipSummaryPrompt).toBe(false);
});

test("a move to a prompt gives back its text to write again; any other move, or one cancelled, none", async () => {
  const open = saved("app", ["first", "second"]);
  const [firstReply, second] = open
    .getEntries()
    .slice(1, 3)
    .map((entry) => entry.id);
  const { ask, moves } = load(open);
  expect(
    await ask({ kind: "navigate", entryId: second, summarize: true, instructions: "keep it short" }),
  ).toEqual({
    id: "1",
    ok: true,
    result: { cancelled: false, text: "second" },
  });
  expect(moves[0]).toEqual([second, { summarize: true, customInstructions: "keep it short" }]);
  expect((await ask({ kind: "navigate", entryId: firstReply, summarize: false })).result).toEqual({
    cancelled: false,
    text: "",
  });
  expect(moves[1]).toEqual([firstReply, { summarize: false }]);
  expect(await ask({ kind: "navigate", entryId: "gone", summarize: false })).toMatchObject({
    ok: false,
    error: "That point is no longer in this session.",
  });
  const kept = load(open, "rpc", { cancel: true });
  expect((await kept.ask({ kind: "navigate", entryId: second, summarize: false })).result).toEqual({
    cancelled: true,
    text: "",
  });
});

test("a label is set through Pi, and an empty one takes it off", async () => {
  const open = saved("app", ["first"]);
  const { ask, labels } = load(open);
  await ask({ kind: "label", entryId: "e1", label: " checkpoint " });
  await ask({ kind: "label", entryId: "e1", label: "" });
  expect(labels).toEqual([
    ["e1", "checkpoint"],
    ["e1", undefined],
  ]);
});
