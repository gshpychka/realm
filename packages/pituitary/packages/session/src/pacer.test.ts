import { describe, expect, test } from "bun:test";
import { EventPacer } from "./pacer.ts";
import type { SessionEvent } from "./protocol.ts";
import { stored } from "./session.fixture.ts";
import { emptySession, reduceAll } from "./session.ts";

/** Drives the pacer's timers by hand so the tests observe flushes deterministically. */
function harness() {
  const applied: SessionEvent[] = [];
  const flushes: number[] = [];
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let nextTimer = 0;
  const pacer = new EventPacer({
    apply: (event) => applied.push(event),
    onFlush: () => flushes.push(applied.length),
    schedule: (callback, delayMs) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delayMs });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => {
      timers.delete(timer as unknown as number);
    },
  });
  const fire = (delayMs: number) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delayMs !== delayMs) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  return { pacer, applied, flushes, fire, pending: () => timers.size };
}

const messageUpdate = (delta: string): SessionEvent =>
  ({
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  }) as unknown as SessionEvent;

const toolUpdate = (id: string, text: string): SessionEvent =>
  ({
    type: "tool_execution_update",
    toolCallId: id,
    toolName: "bash",
    args: {},
    partialResult: { content: [{ type: "text", text }] },
  }) as unknown as SessionEvent;

describe("EventPacer", () => {
  test("holds message deltas until the frame elapses, then applies them in order", () => {
    const { pacer, applied, fire } = harness();
    pacer.handle(messageUpdate("a"));
    pacer.handle(messageUpdate("b"));
    expect(applied).toHaveLength(0);
    fire(33);
    expect(
      applied.map(
        (event) => (event as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta,
      ),
    ).toEqual(["a", "b"]);
  });

  test("repaints once per frame regardless of delta count", () => {
    const { pacer, flushes, fire } = harness();
    for (const delta of ["a", "b", "c", "d"]) pacer.handle(messageUpdate(delta));
    fire(33);
    expect(flushes).toEqual([4]);
  });

  test("keeps only the newest cumulative output per tool call", () => {
    const { pacer, applied, fire } = harness();
    pacer.handle(toolUpdate("c1", "one"));
    pacer.handle(toolUpdate("c1", "one\ntwo"));
    pacer.handle(toolUpdate("c2", "other"));
    fire(250);
    expect(applied).toHaveLength(2);
    expect(applied.map((event) => (event as { toolCallId: string }).toolCallId)).toEqual(["c1", "c2"]);
  });

  test("a lifecycle event applies pending work first, then itself", () => {
    const { pacer, applied } = harness();
    pacer.handle(messageUpdate("a"));
    pacer.handle({ type: "agent_settled" } as SessionEvent);
    expect(applied.map((event) => event.type)).toEqual(["message_update", "agent_settled"]);
  });

  test("a final tool result follows its sampled output", () => {
    const { pacer, applied } = harness();
    pacer.handle(toolUpdate("c1", "partial"));
    pacer.handle({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "final" }] },
      isError: false,
    } as SessionEvent);
    expect(applied.map((event) => event.type)).toEqual(["tool_execution_update", "tool_execution_end"]);
  });

  test("a burst beyond the cap flushes without waiting", () => {
    const { pacer, applied } = harness();
    for (let index = 0; index < 512; index++) pacer.handle(messageUpdate(String(index)));
    expect(applied).toHaveLength(512);
  });

  test("dispose applies what is left and stops the timers", () => {
    const { pacer, applied, fire, pending } = harness();
    pacer.handle(messageUpdate("a"));
    pacer.dispose();
    expect(applied).toHaveLength(1);
    expect(pending()).toBe(0);
    pacer.handle(messageUpdate("b"));
    fire(33);
    expect(applied).toHaveLength(1);
  });
});

test("an empty final tool result retains sampled output and details", () => {
  const { pacer, applied } = harness();
  pacer.handle({
    type: "message_start",
    message: stored.assistant({ toolCall: { id: "c1", name: "bash", args: {} } }),
  });
  pacer.handle({
    type: "tool_execution_update",
    toolCallId: "c1",
    toolName: "bash",
    args: {},
    partialResult: { content: [{ type: "text", text: "work completed" }], details: { progress: 100 } },
  });
  pacer.handle({
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "bash",
    result: { content: [] },
    isError: false,
  });
  const view = reduceAll(emptySession, applied);
  const tool = view.entries.flatMap((entry) => (entry.kind === "assistant" ? entry.tools : []))[0];
  expect(tool).toMatchObject({ output: "work completed", details: { progress: 100 }, state: "ok" });
});
