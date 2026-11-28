import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@pituitary/session";
import { duraOptions, piCommand, resumePiArgs } from "./cli.ts";
import { PiConversation, type PiUiRequest } from "./pi.ts";
import { BRIDGE_STATUS } from "./pi-bridge.ts";

const fixture = fileURLToPath(new URL("./pi.fixture.ts", import.meta.url));
const BRIDGE = "/fixture/pi-bridge-extension.ts";
/** A fake Pi; with `bridged` it loaded Pituitary's bridge extension. */
const open = (bridged = false) =>
  new PiConversation({
    command: process.execPath,
    args: [fixture, "--model", "test/model"],
    bridge: BRIDGE,
    env: bridged ? { FIXTURE_BRIDGE: BRIDGE } : {},
  });
/** One of the fake Pi's own commands, outside Pi's RPC. */
const ask = (client: PiConversation, type: string) => client.rpc({ type } as never) as Promise<unknown>;

test("regular Pi keeps its executable, options and positional task separate", () => {
  expect(
    piCommand(["--continue", "--model", "provider/model", "fix", "the tests"], {
      PI_AGENT_CMD: "/configured/pi",
    }),
  ).toEqual({
    command: "/configured/pi",
    args: ["--continue", "--model", "provider/model"],
    prompt: "fix the tests",
    resume: false,
    direct: false,
  });
  expect(piCommand(["auth", "check", "--provider", "openai-codex"], {}).direct).toBe(true);
  expect(piCommand(["--resume"], {}).resume).toBe(true);
  expect(
    resumePiArgs(
      ["--model=initial", "--continue", "--thinking", "high", "--extension", "mine.ts"],
      "/tmp/session",
    ),
  ).toEqual(["--extension", "mine.ts", "--session", "/tmp/session"]);
});

test("Dura is selected only by --dura, not its environment defaults", () => {
  expect(duraOptions([], {})).toBeUndefined();
  expect(
    duraOptions(["--model", "provider/model", "fix the tests"], {
      DURA_STATE_DIR: "/tmp/state",
      DURA_RUNTIME_SOCKET: "/tmp/runtime.sock",
    }),
  ).toBeUndefined();
});

test("Dura uses its canonical local state without requiring --state or --socket", () => {
  expect(duraOptions(["--dura", "team"], {})).toEqual({
    run: "team",
    state: join(homedir(), ".local", "state", "dura"),
    watch: false,
  });
  expect(duraOptions(["--dura", "team"], { XDG_STATE_HOME: "/tmp/xdg-state" })).toEqual({
    run: "team",
    state: "/tmp/xdg-state/dura",
    watch: false,
  });
});

test("Dura state selection prefers --state, then DURA_STATE_DIR, then XDG state", () => {
  const environment = { DURA_STATE_DIR: "/tmp/configured-state", XDG_STATE_HOME: "/tmp/xdg-state" };
  expect(duraOptions(["--dura", "team"], environment)).toEqual({
    run: "team",
    state: "/tmp/configured-state",
    watch: false,
  });
  expect(duraOptions(["--dura", "team", "--state", "/tmp/state", "--watch"], environment)).toEqual({
    run: "team",
    state: "/tmp/state",
    watch: true,
  });
});

test("Dura sockets remain explicit and do not require --state", () => {
  const environment = { XDG_STATE_HOME: "/tmp/xdg-state", DURA_RUNTIME_SOCKET: "/tmp/configured.sock" };
  expect(duraOptions(["--dura", "team"], environment)).toEqual({
    run: "team",
    state: "/tmp/xdg-state/dura",
    socket: "/tmp/configured.sock",
    watch: false,
  });
  expect(
    duraOptions(["--dura", "team", "--socket", "/tmp/tunnel.sock", "--task", "child-task"], environment),
  ).toEqual({
    run: "team",
    state: "/tmp/xdg-state/dura",
    socket: "/tmp/tunnel.sock",
    task: "child-task",
    watch: false,
  });
});

test("Dura rejects unknown options and missing values even with state defaults", () => {
  for (const flag of ["--dura", "--state", "--task", "--socket"]) {
    const argv = flag === "--dura" ? [flag] : ["--dura", "team", flag];
    expect(() => duraOptions(argv, {})).toThrow(`${flag} requires a value`);
    expect(() => duraOptions([...argv, "--watch"], {})).toThrow(`${flag} requires a value`);
  }
  expect(() => duraOptions(["--dura", "team", "--unknown"], {})).toThrow("Unknown Dura frontend option");
});

test("Pi RPC preserves arguments and extension requests emitted during startup", async () => {
  const client = open();
  try {
    const state = await client.getState();
    expect(state.sessionId).toBe("pi-session");
    expect(client.sessionFile).toBe("/tmp/pi-session.jsonl");
    expect(await ask(client, "fixture_args")).toEqual(["--model", "test/model", "--mode", "rpc"]);
    const requests: PiUiRequest[] = [];
    const off = client.onRequest((request) => requests.push(request));
    expect(requests).toMatchObject([{ method: "notify", message: "Pi extension ready" }]);
    client.respond({ type: "extension_ui_response", id: "question", value: "yes" });
    expect(await ask(client, "fixture_answer")).toEqual({
      type: "extension_ui_response",
      id: "question",
      value: "yes",
    });
    off();
  } finally {
    await client.close();
  }
});

test("a Pi snapshot captures its precise stream position, including live tools", async () => {
  const client = open();
  try {
    await ask(client, "fixture_stream");
    const events: Array<{ sequence: number; type: string }> = [];
    client.onEvent((event, sequence) => events.push({ sequence, type: event.type }));
    const snapshot = await client.getSnapshot();
    expect(snapshot.state.isStreaming).toBe(true);
    expect(snapshot.streamingMessage).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "before" }],
    });
    expect(snapshot.pendingToolCalls).toEqual(["read-1"]);
    expect(snapshot.pendingTools).toMatchObject([{ callId: "read-1", name: "read", output: "Reading" }]);
    expect(events.some((event) => event.sequence > snapshot.sequence)).toBe(true);
  } finally {
    await client.close();
  }
});

test("Pi process exit rejects outstanding requests and notifies an attached frontend", async () => {
  const client = open();
  try {
    await client.getState();
    const closed = new Promise<string>((resolve) => client.onClose(resolve));
    await expect(ask(client, "fixture_exit")).rejects.toThrow("Pi exited");
    expect(await closed).toContain("3");
    await expect(client.getState()).rejects.toThrow("Pi exited");
  } finally {
    await client.close();
  }
});

test("Pi's wire tool-call stream preserves identity and authoritative completed arguments", async () => {
  const client = open();
  try {
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));
    await ask(client, "fixture_tool_start");
    const initial = await client.getSnapshot();
    expect(initial.streamingMessage).toMatchObject({
      content: [{ type: "text" }, { type: "toolCall", id: "read-stream", name: "read" }],
    });
    expect(events).toContainEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "read-stream",
        toolName: "read",
      },
    });
    await ask(client, "fixture_tool_end");
    const complete = await client.getSnapshot();
    expect(complete.streamingMessage).toMatchObject({
      content: [
        { type: "text" },
        { type: "toolCall", id: "read-stream", name: "read", arguments: { path: "README.md" } },
      ],
    });
  } finally {
    await client.close();
  }
});

test("manual and automatic Pi compaction share its canonical compaction events", async () => {
  const client = open();
  try {
    await ask(client, "fixture_compaction_start");
    expect((await client.getSnapshot()).state.isCompacting).toBe(true);
    await ask(client, "fixture_compaction_end");
    expect((await client.getSnapshot()).state.isCompacting).toBe(false);
  } finally {
    await client.close();
  }
});

test("the bridge is found by its file under Pi's renamed command, and answers out of band", async () => {
  const client = open(true);
  try {
    const shown: PiUiRequest[] = [];
    client.onRequest((request) => shown.push(request));
    const { sessions } = await client.bridge({ kind: "sessions", all: false });
    expect(client.workspace().bridge).toBe("pituitary:2");
    // A malformed session in the reply is dropped rather than shown.
    expect(sessions).toEqual([
      { path: "/s/a.jsonl", id: "a", cwd: "/w", modified: 2, messages: 3, first: "hello" },
    ]);
    expect(
      shown.some((request) => request.method === "setStatus" && request.statusKey === BRIDGE_STATUS),
    ).toBe(false);
    // The bridge's own command failing rejects its request instead of reaching the transcript.
    const events: SessionEvent[] = [];
    client.onEvent((event) => events.push(event));
    await expect(client.bridge({ kind: "reload" })).rejects.toThrow("reload exploded");
    expect(events).toEqual([]);
    await ask(client, "fixture_extension_error");
    expect(events).toEqual([
      {
        type: "extension_error",
        extensionPath: "/home/operator/.pi/agent/extensions/demo.ts",
        event: "before_agent_start",
        error: "demo handler exploded",
      },
    ]);
  } finally {
    await client.close();
  }
});

test("without Pi's bridge command a request is refused before anything reaches Pi", async () => {
  const client = open();
  try {
    await expect(client.bridge({ kind: "sessions", all: true })).rejects.toThrow("nothing was sent");
    expect(client.workspace().bridge).toBeNull();
    expect(await ask(client, "fixture_received")).not.toContain("prompt");
  } finally {
    await client.close();
  }
});

test("a replaced session reaches its listeners, and a runtime's working directory becomes the workspace's", async () => {
  const client = open();
  try {
    let replaced = 0;
    client.onReplace(() => replaced++);
    expect(await client.newSession()).toBe(true);
    expect(replaced).toBe(1);
    const shown: PiUiRequest[] = [];
    client.onRequest((request) => shown.push(request));
    await ask(client, "fixture_runtime");
    expect(client.workspace().cwd).toBe("/elsewhere");
    expect(shown.at(-1)).toMatchObject({ method: "setStatus", statusKey: "pituitary.runtime" });
  } finally {
    await client.close();
  }
});
