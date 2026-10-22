import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { treeRows } from "./tree.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const reply = (text: string): Parameters<SessionManager["appendMessage"]>[0] => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage,
  stopReason: "stop",
  timestamp: 0,
});

describe("treeRows", () => {
  test("a straight conversation reads as one column, the latest entry marked", () => {
    const session = SessionManager.inMemory("/repo");
    session.appendMessage({ role: "user", content: "first", timestamp: 0 });
    session.appendMessage(reply("one"));
    const rows = treeRows(session.getTree(), session.getLeafId());
    expect(rows.map((row) => row.label)).toEqual(["• you: first", "◆ pi: one"]);
    expect(rows.find((row) => row.current)?.label).toBe("◆ pi: one");
    expect(rows[0]?.editorText).toBe("first");
  });

  test("a branch point indents each branch, and the path to the leaf is marked", () => {
    const session = SessionManager.inMemory("/repo");
    const root = session.appendMessage({ role: "user", content: "root", timestamp: 0 });
    session.appendMessage(reply("left"));
    session.branch(root);
    session.appendMessage(reply("right"));
    const rows = treeRows(session.getTree(), session.getLeafId());
    expect(rows.map((row) => row.label)).toEqual(["• you: root", "    pi: left", "  ◆ pi: right"]);
  });

  test("bookkeeping entries are left out, and the nearest listed entry above the leaf is current", () => {
    const session = SessionManager.inMemory("/repo");
    session.appendMessage({ role: "user", content: "go", timestamp: 0 });
    session.appendThinkingLevelChange("high");
    const rows = treeRows(session.getTree(), session.getLeafId());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.current).toBe(true);
  });
});
