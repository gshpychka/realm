import { describe, expect, test } from "bun:test";
import type { AssistantEntry, Entry, ToolView } from "@pituitary/session";
import { type Item, summary, transcriptOf, type Work, worked } from "./transcript.ts";

const tool = (id: string, state: ToolView["state"] = "ok"): ToolView => ({
  id,
  name: "bash",
  args: { command: id },
  state,
  output: "",
});

const reply = (id: string, parts: Partial<AssistantEntry> = {}): AssistantEntry => ({
  kind: "assistant",
  id,
  text: "",
  thinking: "",
  tools: [],
  done: true,
  ...parts,
});

const user = (id: string): Extract<Entry, { kind: "user" }> => ({ kind: "user", id, text: id });

/** Each item as its kind and what it holds, for comparing at a glance. */
const shape = (items: Item[]) =>
  items.map((item) => {
    if (item.kind === "work")
      return `work(${item.steps.map((step) => step.id).join(" ")})${item.live ? " live" : ""}`;
    if (item.kind === "reply") return `reply(${item.text})${item.streaming ? " streaming" : ""}`;
    return item.kind;
  });

describe("transcriptOf", () => {
  test("a run's thinking, narration, and tool calls share one box, and its last words follow it", () => {
    const entries = [
      user("u"),
      reply("a1", { thinking: "plan", text: "Looking first.", tools: [tool("t1")] }),
      reply("a2", { thinking: "next", tools: [tool("t2"), tool("t3")] }),
      reply("a3", { thinking: "done", text: "All fixed." }),
    ];
    expect(shape(transcriptOf(entries, false))).toEqual([
      "user",
      "work(a1:thinking a1:text t1 a2:thinking t2 t3 a3:thinking)",
      "reply(All fixed.)",
    ]);
  });

  test("a reply with nothing before it draws no box", () => {
    expect(shape(transcriptOf([user("u"), reply("a", { text: "Hi." })], false))).toEqual([
      "user",
      "reply(Hi.)",
    ]);
  });

  test("the box stays live until the last reply ends without calling a tool", () => {
    const working = [user("u"), reply("a1", { tools: [tool("t1", "running")] })];
    expect(shape(transcriptOf(working, true))).toEqual(["user", "work(t1) live"]);

    // Words still arriving may yet lead to a tool call, so the box waits on them.
    const answering = [...working, reply("a2", { thinking: "so", text: "It is", done: false })];
    expect(shape(transcriptOf(answering, true))).toEqual([
      "user",
      "work(t1 a2:thinking) live",
      "reply(It is) streaming",
    ]);

    const answered = [...working, reply("a2", { thinking: "so", text: "It is done." })];
    expect(shape(transcriptOf(answered, true))).toEqual([
      "user",
      "work(t1 a2:thinking)",
      "reply(It is done.)",
    ]);
  });

  test("words that went on to a tool call move into the box as narration", () => {
    const entries = [
      user("u"),
      reply("a1", { text: "Checking.", tools: [tool("t1", "running")], done: false }),
    ];
    expect(shape(transcriptOf(entries, true))).toEqual(["user", "work(a1:text t1) live"]);
  });

  test("an entry between replies closes the box before it, and work after it opens another", () => {
    const entries = [
      user("u"),
      reply("a1", { tools: [tool("t1")] }),
      { kind: "notice", id: "n", level: "warning", text: "slow" } as Entry,
      reply("a2", { tools: [tool("t2", "running")] }),
    ];
    expect(shape(transcriptOf(entries, true))).toEqual(["user", "work(t1)", "notice", "work(t2) live"]);
  });

  test("a run that has ended leaves its box closed, whatever its last reply did", () => {
    const entries = [user("u"), reply("a1", { tools: [tool("t1", "error")] })];
    expect(shape(transcriptOf(entries, false))).toEqual(["user", "work(t1)"]);
  });

  test("a reply cut at the output limit says so, even with no words of its own", () => {
    const [, box, cut] = transcriptOf(
      [user("u"), reply("a1", { tools: [tool("t1")], stopReason: "length" })],
      false,
    );
    expect(box?.kind).toBe("work");
    expect(cut).toEqual({
      kind: "reply",
      id: "a1",
      text: "",
      streaming: false,
      note: "the reply reached the output limit and stopped",
    });
  });

  test("a reply that failed before it said anything leaves nothing", () => {
    expect(transcriptOf([user("u"), reply("a1", { stopReason: "error" })], false)).toEqual([user("u")]);
  });
});

describe("summary", () => {
  const boxOf = (entry: AssistantEntry) => transcriptOf([entry], true)[0] as Work;

  test("says whether the model thought, how many tools it called, and how many failed", () => {
    const busy = reply("a1", {
      thinking: "hm",
      tools: [tool("t1"), tool("t2", "error"), tool("t3", "running")],
    });
    expect(summary(boxOf(busy))).toBe("thought · 3 tools · 1 failed");
    expect(summary(boxOf(reply("a2", { tools: [tool("t1")] })))).toBe("1 tool");
    expect(summary(boxOf(reply("a3", { thinking: "hm", text: "Hi." })))).toBe("thought");
  });
});

describe("worked", () => {
  test("holds for thinking or a tool call, and not for words alone", () => {
    expect(worked([user("u"), reply("a", { text: "Hi." })])).toBe(false);
    expect(worked([reply("a", { thinking: "hm", text: "Hi." })])).toBe(true);
    expect(worked([reply("a", { tools: [tool("t")] })])).toBe(true);
  });
});
