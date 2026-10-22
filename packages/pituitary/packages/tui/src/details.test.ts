import { describe, expect, test } from "bun:test";
import type { ToolView } from "@pituitary/rpc";
import { detailsOf, fullOutputOf } from "./details.ts";

const call = (name: string, details: unknown): ToolView => ({
  id: "t",
  name,
  args: {},
  state: "ok",
  output: "",
  details,
});

describe("detailsOf", () => {
  test("reads what each tool it knows attaches", () => {
    expect(detailsOf(call("edit", { diff: "- a\n+ b" }))).toEqual({ kind: "diff", diff: "- a\n+ b" });
    expect(detailsOf(call("plan_mode_complete", { plan: "1. go" }))).toEqual({ kind: "plan", plan: "1. go" });
    expect(detailsOf(call("web_search", { phase: "searching", curatorUrl: "http://x" }))).toEqual({
      kind: "search",
      phase: "searching",
      curatorUrl: "http://x",
    });
    expect(
      detailsOf(call("subagent", { displayName: "scout", tokens: 1200, status: "done", extra: true })),
    ).toMatchObject({ kind: "subagent", name: "scout", tokens: 1200, status: "done" });
  });

  test("keeps what the operator answered, or that the questions were cancelled", () => {
    const answered = { answers: [{ question: "Cap?", answer: "168h" }, { answer: 3 }] };
    expect(detailsOf(call("ask_user_question", answered))).toEqual({
      kind: "answers",
      answers: [
        { question: "Cap?", answer: "168h" },
        { question: undefined, answer: undefined },
      ],
    });
    expect(detailsOf(call("ask_user_question", { answers: [], cancelled: true }))).toEqual({
      kind: "cancelled",
    });
  });

  test("leaves a field of the wrong type, a tool it does not know, and no details at all to the output", () => {
    expect(detailsOf(call("edit", { diff: 3 }))).toBeNull();
    expect(detailsOf(call("subagent", { displayName: ["scout"] }))).toBeNull();
    expect(detailsOf(call("mcp", { diff: "- a" }))).toBeNull();
    expect(detailsOf(call("todo", undefined))).toBeNull();
    expect(detailsOf(call("todo", "tasks"))).toBeNull();
  });
});

describe("fullOutputOf", () => {
  test("names where pi kept a cut output, and nothing otherwise", () => {
    expect(fullOutputOf(call("bash", { fullOutputPath: "/tmp/out" }))).toBe("/tmp/out");
    expect(fullOutputOf(call("bash", { fullOutputPath: 1 }))).toBeNull();
    expect(fullOutputOf(call("bash", null))).toBeNull();
  });
});
