import { describe, expect, test } from "bun:test";
import type { PiEvent } from "./protocol.ts";
import {
  abortedRun,
  agentRun,
  assistantTurn,
  customTurn,
  failedTurn,
  stored,
  toolRun,
  userTurn,
} from "./scripted.ts";
import {
  activityOf,
  elapsed,
  emptySession,
  OUTPUT_KEPT,
  partialJson,
  reduce,
  reduceAll,
  restore,
  type SessionAction,
  type SessionView,
  transcript,
} from "./session.ts";

function run(events: PiEvent[]): SessionView {
  return reduceAll(emptySession, events);
}

describe("reduce", () => {
  test("builds the conversation from the event stream alone", () => {
    const view = run(agentRun([userTurn("hello"), assistantTurn({ text: "hi back" })]));
    expect(view.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "turn"]);
    expect(transcript(view)).toBe("> hello\nhi back");
    expect(view.phase).toBe("idle");
    expect(view.running).toBe(false);
  });

  test("streams text deltas into the open assistant entry", () => {
    const events = agentRun([userTurn("q"), assistantTurn({ text: "abcdef", parts: 3 })]);
    const upToSecondDelta = events.slice(0, events.findIndex((event) => isDelta(event, "text_delta")) + 2);
    const view = run(upToSecondDelta);
    const assistant = view.entries.at(-1);
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected an assistant entry");
    expect(assistant.text).toBe("abcd");
    expect(assistant.done).toBe(false);
    expect(view.phase).toBe("streaming");
  });

  test("keeps thinking separate from the answer", () => {
    const view = run(agentRun([userTurn("q"), assistantTurn({ thinking: "hmm", text: "answer" })]));
    const assistant = view.entries.findLast((entry) => entry.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected an assistant entry");
    expect(assistant.thinking).toBe("hmm");
    expect(assistant.text).toBe("answer");
  });

  test("tracks a tool call from stream through execution to result", () => {
    const view = run(
      agentRun([
        userTurn("list"),
        assistantTurn({ text: "running", toolCall: { id: "c1", name: "bash", args: { command: "ls" } } }),
        toolRun({ id: "c1", name: "bash", args: { command: "ls" }, output: ["a", "a\nb"] }),
      ]),
    );
    const assistant = view.entries.findLast((entry) => entry.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected an assistant entry");
    expect(assistant.tools).toHaveLength(1);
    expect(assistant.tools[0]).toMatchObject({ name: "bash", state: "ok", output: "a\nb" });
  });

  test("marks a failed tool call", () => {
    const view = run(
      agentRun([
        userTurn("run"),
        assistantTurn({ text: "running", toolCall: { id: "c1", name: "bash", args: { command: "false" } } }),
        toolRun({ id: "c1", name: "bash", args: { command: "false" }, output: ["boom"], isError: true }),
      ]),
    );
    const assistant = view.entries.findLast((entry) => entry.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected an assistant entry");
    expect(assistant.tools[0]?.state).toBe("error");
  });

  test("attaches execution events that arrive before the tool call is known", () => {
    const view = run([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "tool_execution_start", toolCallId: "late", toolName: "read", args: { path: "x" } },
    ] as PiEvent[]);
    const assistant = view.entries.at(-1);
    if (assistant?.kind !== "assistant") throw new Error("expected an assistant entry");
    expect(assistant.tools[0]).toMatchObject({ id: "late", name: "read", state: "running" });
  });

  test("reports the retry phase with when the next attempt starts, and recovers", () => {
    const started = reduce(emptySession, { type: "agent_start" }, 1_000);
    const during = reduce(
      started,
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 200, errorMessage: "529" },
      5_000,
    );
    expect(during.phase).toBe("retrying");
    expect(during.retry).toEqual({ attempt: 1, maxAttempts: 3, at: 5_200, error: "529" });

    const after = reduceAll(during, [{ type: "auto_retry_end", success: true, attempt: 2 }] as PiEvent[]);
    expect(after.phase).toBe("streaming");
    expect(after.retry).toBeNull();
  });

  test("a run's start time holds through a retry and clears when it settles", () => {
    const first = reduce(emptySession, { type: "agent_start" }, 1_000);
    const again = reduce(first, { type: "agent_start" }, 9_000);
    expect(again.startedAt).toBe(1_000);
    expect(reduce(again, { type: "agent_settled" }).startedAt).toBeNull();
  });

  test("surfaces an exhausted retry as an error notice", () => {
    const view = run([
      { type: "agent_start" },
      { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "529" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" },
    ] as PiEvent[]);
    expect(view.entries.at(-1)).toMatchObject({ kind: "notice", level: "error", text: "overloaded" });
    expect(view.running).toBe(false);
  });

  test("tracks the compaction phase", () => {
    const view = run([{ type: "compaction_start", reason: "threshold" }] as PiEvent[]);
    expect(view.phase).toBe("compacting");
    expect(view.detail).toBe("compacting (threshold)");
  });

  test("mirrors the steering and follow-up queues", () => {
    const view = run([{ type: "queue_update", steering: ["focus"], followUp: ["then this"] }] as PiEvent[]);
    expect(view.queue).toEqual({ steering: ["focus"], followUp: ["then this"] });
  });

  test("closes the open assistant entry when the agent stops", () => {
    const view = run([
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "agent_end", messages: [] },
    ] as PiEvent[]);
    const assistant = view.entries.at(-1);
    if (assistant?.kind !== "assistant") throw new Error("expected an assistant entry");
    expect(assistant.done).toBe(true);
  });

  test("records a bash execution message", () => {
    const view = run([
      {
        type: "message_start",
        message: { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 },
      },
    ] as unknown as PiEvent[]);
    expect(view.entries.at(-1)).toMatchObject({ kind: "bash", command: "ls", exitCode: 0 });
  });

  test("gives every entry a distinct id", () => {
    const view = run(
      agentRun([
        userTurn("one"),
        assistantTurn({ text: "a" }),
        userTurn("two"),
        assistantTurn({ text: "b" }),
      ]),
    );
    const ids = view.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

function isDelta(event: PiEvent, type: string): boolean {
  return (
    event.type === "message_update" &&
    (event as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type === type
  );
}

describe("restore", () => {
  const history = [
    stored.compaction("Earlier: set up the payout limits module.", 120_000),
    stored.user("cap the window at 168h"),
    stored.assistant({
      thinking: "Mirror the lower bound.",
      text: "Adding the upper bound.",
      toolCall: { id: "c1", name: "edit", args: { path: "limits.ts" } },
    }),
    stored.toolResult({ id: "c1", name: "edit", output: "applied", details: { diff: "+1 -0" } }),
    stored.custom({ customType: "proposed-plan", text: "1. read limits.ts" }),
    stored.custom({ customType: "plan-mode-transition", text: "hidden", display: false }),
    stored.assistant({ text: "Done." }),
  ];

  test("rebuilds the conversation a stored session holds", () => {
    const view = restore(history);
    expect(view.entries.map((entry) => entry.kind)).toEqual([
      "summary",
      "user",
      "assistant",
      "custom",
      "assistant",
    ]);
    expect(transcript(view)).toBe(
      [
        "[compaction] Earlier: set up the payout limits module.",
        "> cap the window at 168h",
        "~ Mirror the lower bound.",
        "Adding the upper bound.",
        "[ok] edit applied",
        "[proposed-plan] 1. read limits.ts",
        "Done.",
      ].join("\n"),
    );
    expect(view.running).toBe(false);
  });

  test("counts every message, displayed or not", () => {
    expect(restore(history).messages).toBe(history.length);
  });

  test("keeps the details a tool attached", () => {
    const assistant = restore(history).entries.find((entry) => entry.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.tools[0]?.details).toEqual({ diff: "+1 -0" });
  });

  test("an assistant message streamed without deltas takes its text from the final message", () => {
    const message = stored.assistant({ text: "whole answer" });
    const view = run([
      { type: "message_start", message: { ...message, content: [] } } as PiEvent,
      { type: "message_end", message },
    ]);
    expect(transcript(view)).toBe("whole answer");
  });

  test("a custom message the extension hides stays out of the conversation", () => {
    const view = run(customTurn(stored.custom({ customType: "state", text: "x", display: false })));
    expect(view.entries).toEqual([]);
  });
});

describe("operator commands", () => {
  const start = { type: "bash_start", request: "b1", command: "ls", excluded: false } as const;
  const chunk = (delta: string) => ({ type: "bash_execution_update", id: "b1", delta }) as PiEvent;
  const end = {
    type: "bash_end",
    request: "b1",
    result: { output: "a\nb\n", exitCode: 0, cancelled: false, truncated: false },
  } as const;

  test("streams output into its entry and settles on the result", () => {
    const streaming = reduceAll(emptySession, [start, chunk("a\n")]);
    expect(streaming.entries[0]).toMatchObject({ kind: "bash", output: "a\n", running: true });
    const done = reduceAll(streaming, [chunk("b\n"), end]);
    expect(done.entries[0]).toMatchObject({ output: "a\nb\n", exitCode: 0, running: false });
  });

  test("is counted at once when idle, as pi records it", () => {
    expect(reduceAll(emptySession, [start, end]).messages).toBe(1);
  });

  test("is counted when the run settles when one was in progress", () => {
    const during = reduceAll(emptySession, [{ type: "agent_start" }, start, end]);
    expect(during.messages).toBe(0);
    expect(reduceAll(during, [{ type: "agent_settled" }]).messages).toBe(1);
  });

  test("output for another request, or none, leaves it alone", () => {
    const view = reduceAll(emptySession, [
      start,
      { type: "bash_execution_update", id: "other", delta: "x" } as PiEvent,
      { type: "bash_execution_update", delta: "y" } as unknown as PiEvent,
    ]);
    expect(view.entries[0]).toMatchObject({ output: "" });
  });
});

describe("what real pi sends", () => {
  test("a provider error ends the reply with a notice carrying pi's message", () => {
    const view = run(agentRun([userTurn("q"), failedTurn("400 prompt is too long")]));
    expect(transcript(view)).toContain("! 400 prompt is too long");
    expect(view.running).toBe(false);
  });

  test("an extension's failure names the extension, not the path pi loaded it from", () => {
    const failed = (extensionPath: string) =>
      run([{ type: "extension_error", extensionPath, event: "session_start", error: "boom" }]).entries.at(-1);
    expect(failed("/nix/store/abc-pi-packages/node_modules/pi-mcp-adapter/index.ts")).toMatchObject({
      kind: "notice",
      level: "error",
      text: "pi-mcp-adapter: boom",
    });
    expect(failed("/home/me/node_modules/@scope/guard/dist/main.js")).toMatchObject({
      text: "@scope/guard: boom",
    });
    expect(failed("/home/me/.pi/agent/extensions/plan/index.ts")).toMatchObject({ text: "plan: boom" });
    expect(failed("/home/me/.pi/agent/extensions/notify.ts")).toMatchObject({ text: "notify: boom" });
  });

  test("an aborted reply says so", () => {
    const view = run([
      { type: "agent_start" },
      ...userTurn("q"),
      { type: "message_start", message: stored.assistant({}) },
      ...abortedRun(),
    ]);
    expect(transcript(view)).toContain("! aborted");
  });

  test("a retry drops the failed attempt, as pi drops it from the session", () => {
    const view = run([
      { type: "agent_start" },
      ...userTurn("q"),
      ...failedTurn("529 overloaded"),
      { type: "agent_end", messages: [], willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529 overloaded" },
      { type: "agent_start" },
      ...assistantTurn({ text: "recovered" }),
      { type: "auto_retry_end", success: true, attempt: 2 },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ]);
    expect(transcript(view)).toBe("> q\nrecovered");
    expect(view.messages).toBe(2);
  });

  test("a reply of several text blocks keeps every block as it streams", () => {
    const events = [
      { type: "message_start", message: stored.assistant({}) },
      ...["First.", "Then write it."].flatMap((text, contentIndex) => [
        { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex } },
        {
          type: "message_update",
          usage: {},
          assistantMessageEvent: { type: "text_delta", contentIndex, delta: text },
        },
        {
          type: "message_update",
          usage: {},
          assistantMessageEvent: { type: "text_end", contentIndex, content: text },
        },
      ]),
    ] as PiEvent[];
    expect(transcript(run(events))).toBe("First.\n\nThen write it.");
  });

  test("a tool call shows from its start, with arguments filling in as they stream", () => {
    const events = [
      { type: "message_start", message: stored.assistant({}) },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "w1", toolName: "write" },
      },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"path":"NOTES.md","content":"# No',
        },
      },
    ] as PiEvent[];
    const entry = run(events).entries[0];
    expect(entry?.kind === "assistant" && entry.tools[0]).toMatchObject({
      name: "write",
      args: { path: "NOTES.md", content: "# No" },
    });
  });

  test("a restored tool call with no result shows as interrupted", () => {
    const view = restore([
      stored.user("q"),
      stored.assistant({ toolCall: { id: "c1", name: "bash", args: { command: "sleep 99" } } }),
    ]);
    const entry = view.entries.find((each) => each.kind === "assistant");
    expect(entry?.kind === "assistant" && entry.tools[0]).toMatchObject({
      state: "error",
      output: "interrupted",
    });
  });

  test("the agent going away ends whatever was in progress", () => {
    const view = reduceAll(emptySession, [
      { type: "agent_start" },
      { type: "bash_start", request: "b1", command: "make", excluded: false },
      { type: "closed" },
    ]);
    expect(view.running).toBe(false);
    expect(view.entries[0]).toMatchObject({ running: false, cancelled: true });
  });

  test("a disconnect closes the streamed reply and interrupts unfinished tools", () => {
    const during = run([
      { type: "agent_start" },
      { type: "message_start", message: stored.assistant({}) },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 99" } },
    ]);
    const view = reduce(during, { type: "closed" }, 100);
    const assistant = view.entries.find((entry) => entry.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.done).toBe(true);
    expect(assistant?.kind === "assistant" && assistant.tools[0]).toMatchObject({
      state: "error",
      endedAt: 100,
      output: "interrupted",
    });
  });
});

describe("partialJson", () => {
  test("reads arguments that are still arriving", () => {
    expect(partialJson('{"path":"a.ts","conte')).toBeNull();
    expect(partialJson('{"path":"a.ts","content":"x')).toEqual({ path: "a.ts", content: "x" });
    expect(partialJson('{"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });
});

describe("a command that never stops talking", () => {
  test("keeps a bounded tail of its output", () => {
    let view = reduce(emptySession, { type: "bash_start", request: "b", command: "yes", excluded: false });
    const chunk = "y\n".repeat(50_000);
    for (let index = 0; index < 20; index++) {
      view = reduce(view, { type: "bash_execution_update", id: "b", delta: chunk } as PiEvent);
    }
    const entry = view.entries[0];
    expect(entry?.kind === "bash" && entry.output.length).toBeLessThanOrEqual(OUTPUT_KEPT);
    expect(entry?.kind === "bash" && entry.output.startsWith("y\n")).toBe(true);
  });
});

describe("what the run is doing", () => {
  const call = { id: "c1", name: "bash", args: { command: "ls" } };
  const prompt = [{ type: "agent_start" }, { type: "turn_start" }, ...userTurn("q")] as PiEvent[];

  test("the model reads until its reply streams, thinks while only reasoning has, and writes once more does", () => {
    const reply = assistantTurn({ thinking: "hmm", text: "answer" });
    const opened = reply.findIndex((event) => isDelta(event, "thinking_start"));
    const thinking = reply.findIndex((event) => isDelta(event, "thinking_delta"));
    const writing = reply.findIndex((event) => isDelta(event, "text_delta"));
    expect(activityOf(run(prompt))).toEqual({ kind: "reading" });
    expect(activityOf(run([...prompt, ...reply.slice(0, opened + 1)]))).toEqual({ kind: "reading" });
    expect(activityOf(run([...prompt, ...reply.slice(0, thinking + 1)]))).toEqual({ kind: "thinking" });
    expect(activityOf(run([...prompt, ...reply.slice(0, writing + 1)]))).toEqual({ kind: "writing" });
    const streamingCall = assistantTurn({ toolCall: call });
    const started = streamingCall.findIndex((event) => isDelta(event, "toolcall_start"));
    expect(activityOf(run([...prompt, ...streamingCall.slice(0, started + 1)]))).toEqual({ kind: "writing" });
  });

  test("a tool call is what the run does from the reply's end until its result, which the model then reads", () => {
    const reply = assistantTurn({ text: "listing", toolCall: call });
    const execution = toolRun({ ...call, output: ["a", "a\nb"] });
    expect(activityOf(run([...prompt, ...reply]))).toEqual({ kind: "tools", names: ["bash"] });
    expect(activityOf(run([...prompt, ...reply, ...execution.slice(0, 2)]))).toEqual({
      kind: "tools",
      names: ["bash"],
    });
    expect(activityOf(run([...prompt, ...reply, ...execution]))).toEqual({ kind: "reading" });
    const next = assistantTurn({ text: "done" });
    expect(activityOf(run([...prompt, ...reply, ...execution, next[0] as PiEvent]))).toEqual({
      kind: "reading",
    });
  });

  test("several tool calls at once are each named until they finish", () => {
    const first = { id: "c1", name: "read", args: { path: "a" } };
    const second = { id: "c2", name: "bash", args: { command: "ls" } };
    const reply = {
      role: "assistant",
      content: [first, second].map(({ id, name, args }) => ({ type: "toolCall", id, name, arguments: args })),
      stopReason: "toolUse",
    } as unknown as Extract<PiEvent, { type: "message_end" }>["message"];
    const view = run([
      ...prompt,
      { type: "message_start", message: reply },
      { type: "message_end", message: reply },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: first.args },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: second.args },
    ] as PiEvent[]);
    expect(activityOf(view)).toEqual({ kind: "tools", names: ["read", "bash"] });
    const one = reduceAll(view, toolRun({ ...first, output: ["a"] }).slice(-3));
    expect(activityOf(one)).toEqual({ kind: "tools", names: ["bash"] });
  });

  test("an open dialog is the operator's turn, whatever else is under way", () => {
    const view = reduce(run([...prompt, ...assistantTurn({ toolCall: call })]), {
      type: "waiting",
      waiting: true,
    });
    expect(activityOf(view)).toEqual({ kind: "operator" });
    expect(activityOf(reduce(view, { type: "waiting", waiting: false }))).toEqual({
      kind: "tools",
      names: ["bash"],
    });
  });
});

describe("the run's clock", () => {
  const start = (at: number) => reduce(emptySession, { type: "agent_start" }, at);
  const waiting = (view: SessionView, on: boolean, at: number) =>
    reduce(view, { type: "waiting", waiting: on }, at);

  test("counts from the run's start", () => {
    expect(elapsed(start(1_000), 4_500)).toBe(3_500);
    expect(elapsed(emptySession, 4_500)).toBe(0);
  });

  test("holds while the operator is waited on and leaves every wait out", () => {
    const asked = waiting(start(1_000), true, 3_000);
    expect(elapsed(asked, 9_000)).toBe(2_000);
    const answered = waiting(asked, false, 10_000);
    expect(elapsed(answered, 11_000)).toBe(3_000);
    const again = waiting(waiting(answered, true, 12_000), false, 15_000);
    expect(elapsed(again, 16_000)).toBe(5_000);
  });

  test("several dialogs open at once are one wait", () => {
    const asked = waiting(waiting(start(1_000), true, 2_000), true, 5_000);
    expect(asked.waitingSince).toBe(2_000);
    expect(elapsed(waiting(asked, false, 8_000), 9_000)).toBe(2_000);
  });

  test("a dialog opened before the run holds it only from the run's start", () => {
    const early = waiting(emptySession, true, 1_000);
    const started = reduce(early, { type: "agent_start" }, 4_000);
    expect(elapsed(started, 6_000)).toBe(0);
    expect(elapsed(waiting(started, false, 7_000), 8_000)).toBe(1_000);
  });

  test("the time waited holds through a retry and clears when the run settles", () => {
    const answered = waiting(waiting(start(1_000), true, 2_000), false, 5_000);
    const retried = reduce(answered, { type: "agent_start" }, 6_000);
    expect(elapsed(retried, 7_000)).toBe(3_000);
    const settled = reduce(retried, { type: "agent_settled" });
    expect(settled.waited).toBe(0);
    expect(elapsed(reduce(settled, { type: "agent_start" }, 20_000), 21_000)).toBe(1_000);
  });
});

describe("the run's output tokens", () => {
  const generated = (view: SessionView) => view.output.finished + view.output.streaming;

  test("grow as a reply streams and settle on what its end reports", () => {
    const reply = assistantTurn({ text: "a".repeat(400), parts: 4, outputTokens: 1_000 });
    const second = reply.findIndex((event) => isDelta(event, "text_delta")) + 1;
    const partway = run([{ type: "agent_start" }, ...reply.slice(0, second + 1)]);
    expect(generated(partway)).toBe(500);
    const done = run([{ type: "agent_start" }, ...reply]);
    expect(done.output).toEqual({ finished: 1_000, streaming: 0 });
  });

  test("add up across the run's replies", () => {
    const view = run([
      { type: "agent_start" },
      ...assistantTurn({ text: "one", outputTokens: 300 }),
      ...assistantTurn({ text: "two", outputTokens: 900 }),
    ] as PiEvent[]);
    expect(generated(view)).toBe(1_200);
  });

  test("start again with each run, and stay out of a restored session", () => {
    const first = run(agentRun([userTurn("q"), assistantTurn({ text: "one", outputTokens: 300 })]));
    expect(generated(first)).toBe(0);
    const next = reduceAll(first, [
      { type: "agent_start" },
      ...assistantTurn({ text: "two", outputTokens: 40 }),
    ]);
    expect(generated(next)).toBe(40);
    expect(generated(restore([stored.user("q"), stored.assistant({ text: "a" })]))).toBe(0);
  });
});

describe("the turn's summary", () => {
  const call = { id: "c1", name: "bash", args: { command: "ls" } };
  const end = [{ type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled" }] as PiEvent[];

  /** Reduces `steps` in order, each number setting the clock for the actions after it. */
  function play(steps: (SessionAction | number)[], from = emptySession): SessionView {
    let now = 0;
    let view = from;
    for (const step of steps) {
      if (typeof step === "number") now = step;
      else view = reduce(view, step, now);
    }
    return view;
  }

  const turns = (view: SessionView) => view.entries.filter((entry) => entry.kind === "turn");

  /** The messages pi records from `events`, which is what `get_messages` returns after them. */
  const recorded = (events: (SessionAction | number)[]) =>
    events.flatMap((event) =>
      typeof event !== "number" && event.type === "message_end" ? [event.message] : [],
    );

  test("ends a turn with the time it worked, its output tokens, the tool calls pi ran, and when it ended", () => {
    const view = play([
      1_000,
      { type: "agent_start" },
      ...userTurn("q"),
      ...assistantTurn({ text: "listing", toolCall: call, outputTokens: 1_240 }),
      ...toolRun({ ...call, output: ["a"] }),
      ...assistantTurn({ text: "done", outputTokens: 360 }),
      13_500,
      ...end,
    ]);
    const [turn] = turns(view);
    expect(view.entries.at(-1)).toBe(turn);
    expect(turn).toMatchObject({ worked: 12_500, output: 1_600, tools: 1, endedAt: 13_500 });
    expect(turn).not.toHaveProperty("outcome");
  });

  test("counts each tool call pi takes up", () => {
    const view = play([
      { type: "agent_start" },
      ...assistantTurn({ toolCall: call }),
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} },
      { type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {} },
      ...end,
    ] as PiEvent[]);
    expect(turns(view)[0]).toMatchObject({ tools: 2 });
  });

  test("leaves out the time a dialog held the turn", () => {
    const view = play([
      1_000,
      { type: "agent_start" },
      3_000,
      { type: "waiting", waiting: true },
      8_000,
      { type: "waiting", waiting: false },
      10_000,
      ...end,
    ]);
    expect(turns(view)[0]).toMatchObject({ worked: 4_000 });
  });

  test("a retry is part of the turn it retries, which ends as its last reply does", () => {
    const view = play([
      1_000,
      { type: "agent_start" },
      ...userTurn("q"),
      ...failedTurn("529 overloaded"),
      { type: "agent_end", messages: [], willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 200, errorMessage: "529" },
      5_000,
      { type: "agent_start" },
      ...assistantTurn({ text: "recovered", outputTokens: 50 }),
      { type: "auto_retry_end", success: true, attempt: 2 },
      7_000,
      ...end,
    ]);
    expect(turns(view)).toHaveLength(1);
    expect(turns(view)[0]).toMatchObject({ worked: 6_000, output: 20 + 50 });
    expect(turns(view)[0]).not.toHaveProperty("outcome");
  });

  test("says when the operator interrupted the turn, or an error ended it", () => {
    const interrupted = play([
      { type: "agent_start" },
      ...userTurn("q"),
      { type: "message_start", message: stored.assistant({}) },
      ...abortedRun(),
    ]);
    expect(turns(interrupted)[0]).toMatchObject({ outcome: "interrupted" });
    const failed = play([{ type: "agent_start" }, ...userTurn("q"), ...failedTurn("400 too long"), ...end]);
    expect(turns(failed)[0]).toMatchObject({ outcome: "error" });
  });

  test("a turn this client joined partway, or one pi never finished, has none", () => {
    const joined = { ...emptySession, running: true, phase: "streaming" as const, startedAt: 1_000 };
    expect(turns(play([...assistantTurn({ text: "a" }), ...end], joined))).toEqual([]);
    const gone = play([{ type: "agent_start" }, ...userTurn("q"), { type: "closed" }, ...end]);
    expect(turns(gone)).toEqual([]);
  });

  test("history from the session has none", () => {
    const events = [{ type: "agent_start" }, ...userTurn("q"), ...assistantTurn({ text: "a" }), ...end];
    expect(turns(restore(recorded(events as PiEvent[])))).toEqual([]);
  });

  test("a rebuild of the same session keeps each summary after the message its turn ended on", () => {
    const events: (SessionAction | number)[] = [
      1_000,
      { type: "agent_start" },
      ...userTurn("first"),
      ...assistantTurn({ text: "listing", toolCall: call }),
      ...toolRun({ ...call, output: ["a"] }),
      ...assistantTurn({ text: "one" }),
      4_000,
      ...end,
      { type: "agent_start" },
      ...userTurn("second"),
      ...assistantTurn({ text: "two" }),
      9_000,
      ...end,
    ];
    const live = play(events);
    const rebuilt = restore(recorded(events), live);
    const shape = (view: SessionView) =>
      view.entries.map((entry) => (entry.kind === "turn" ? `turn ${entry.worked}` : entry.kind));
    expect(shape(rebuilt)).toEqual([
      "user",
      "assistant",
      "assistant",
      "turn 3000",
      "user",
      "assistant",
      "turn 5000",
    ]);
    expect(shape(rebuilt)).toEqual(shape(live));
    expect(new Set(rebuilt.entries.map((entry) => entry.id)).size).toBe(rebuilt.entries.length);
    const elsewhere = restore([stored.user("first"), stored.assistant({ text: "one" })], live);
    expect(turns(elsewhere)).toEqual([]);
  });
});
