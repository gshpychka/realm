import { describe, expect, test } from "bun:test";
import type { AssistantEntry, Entry, ToolView } from "@pituitary/session";
import { type Item, transcriptOf } from "./transcript.ts";

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

const user = (id: string): Extract<Entry, { kind: "user" }> => ({ kind: "user", id, text: id, images: 0 });

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

  test("a reply that failed before it said anything leaves nothing", () => {
    expect(transcriptOf([user("u"), reply("a1", { stopReason: "error" })], false)).toEqual([user("u")]);
  });
});
