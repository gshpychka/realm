import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { duraOptions, piCommand, resumePiArgs } from "./cli.ts";
import { PiConversation, type PiUiRequest } from "./pi.ts";

const fixture = fileURLToPath(new URL("./pi.fixture.ts", import.meta.url));
const open = () =>
  new PiConversation({ command: process.execPath, args: [fixture, "--model", "test/model"] });

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
    expect(await client.request({ type: "fixture_args" })).toEqual([
      "--model",
      "test/model",
      "--mode",
      "rpc",
    ]);
    const requests: PiUiRequest[] = [];
    const off = client.onRequest((request) => requests.push(request));
    expect(requests).toMatchObject([{ method: "notify", message: "Pi extension ready" }]);
    client.respond({ type: "extension_ui_response", id: "question", value: "yes" });
    expect(await client.request({ type: "fixture_answer" })).toEqual({
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
    await client.request({ type: "fixture_stream" });
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
    await expect(client.request({ type: "fixture_exit" })).rejects.toThrow("Pi exited");
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
    await client.request({ type: "fixture_tool_start" });
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
    await client.request({ type: "fixture_tool_end" });
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
    await client.request({ type: "fixture_compaction_start" });
    expect((await client.getSnapshot()).state.isCompacting).toBe(true);
    await client.request({ type: "fixture_compaction_end" });
    expect((await client.getSnapshot()).state.isCompacting).toBe(false);
  } finally {
    await client.close();
  }
});
