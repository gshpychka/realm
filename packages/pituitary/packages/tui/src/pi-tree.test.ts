import { describe, expect, test } from "bun:test";
import type { TreeKind, TreeNode } from "./pi-bridge.ts";
import { treeRows } from "./pi-tree.ts";
import { theme } from "./theme.ts";

const NOW = new Date(2026, 10, 28, 12, 0).getTime();
const AT = new Date(2026, 10, 28, 9, 30).getTime();

const node = (
  id: string,
  parent: string | null,
  kind: TreeKind,
  text = "",
  extra: Partial<TreeNode> = {},
) => ({
  id,
  parent,
  kind,
  text,
  at: AT,
  ...extra,
});

/** Each row as drawn: its lines, its words, and whether it stands for where the session is. */
const drawn = (nodes: TreeNode[], leaf: string | null) =>
  treeRows(nodes, leaf, NOW).items.map(
    (item) => `${item.lead ?? ""}${item.mark?.glyph} ${item.label}${item.current ? " ·here" : ""}`,
  );

describe("the session's tree", () => {
  // alpha was answered; beta was asked and answered after a step of tools; then the session
  // went back before beta and asked gamma, and the model changed after its reply.
  const forked = [
    node("u1", null, "user", "alpha\nmore of alpha"),
    node("a1", "u1", "assistant", "Reply to: alpha"),
    node("u2", "a1", "user", "beta", { label: "checkpoint" }),
    node("a2", "u2", "assistant", ""),
    node("t1", "a2", "tool"),
    node("a3", "t1", "assistant", "done beta"),
    node("u3", "a1", "user", "gamma"),
    node("a4", "u3", "assistant", "Reply to: gamma"),
    node("m1", "a4", "other"),
  ];

  test("draws a chain in one column and steps each branch in where it forks, the session's own first", () => {
    expect(drawn(forked, "m1")).toEqual([
      "▌ alpha",
      "● Reply to: alpha",
      "├─ ▌ gamma",
      "│  ● Reply to: gamma ·here",
      "└─ ▌ beta",
      "   ● done beta",
    ]);
  });

  test("the row for where the session is stands in for bookkeeping after it, which has none", () => {
    expect(treeRows(forked, "m1", NOW).here).toBe("a4");
    expect(treeRows(forked, "a3", NOW).here).toBe("a3");
    // Before the first entry the session stands nowhere a row shows.
    expect(treeRows(forked, null, NOW).here).toBeNull();
  });

  test("colours the marks of the branch the session is on, labels rows and finds them by more than their first line", () => {
    const items = treeRows(forked, "m1", NOW).items;
    const byValue = new Map(items.map((item) => [item.value, item]));
    expect(byValue.get("u3")?.mark?.colour).toBe(theme.user);
    expect(byValue.get("u2")?.mark?.colour).toBe(theme.dim);
    expect(byValue.get("u2")).toMatchObject({
      detail: "checkpoint · 09:30",
      icon: { glyph: expect.any(String) },
    });
    expect(byValue.get("u1")).toMatchObject({ detail: "09:30", keywords: "alpha\nmore of alpha" });
    expect(byValue.get("u1")).not.toHaveProperty("icon");
  });

  test("a step that only called tools has a row while the session stands on it", () => {
    expect(drawn(forked, "a2")).toEqual([
      "▌ alpha",
      "● Reply to: alpha",
      "├─ ▌ beta",
      "│  ● tool calls ·here",
      "│  ● done beta",
      "└─ ▌ gamma",
      "   ● Reply to: gamma",
    ]);
  });

  test("a session asked afresh from before its first prompt has two roots, the session's own first", () => {
    const rooted = [
      node("r1", null, "user", "first try"),
      node("b1", "r1", "assistant", "one"),
      node("r2", null, "user", "second try"),
      node("b2", "r2", "assistant", "two"),
    ];
    expect(drawn(rooted, "b2")).toEqual(["├─ ▌ second try", "│  ● two ·here", "└─ ▌ first try", "   ● one"]);
  });

  test("forks inside a branch step in again beside the lines of the fork above", () => {
    const nested = [
      node("u1", null, "user", "root"),
      node("x", "u1", "user", "left"),
      node("x1", "x", "user", "left again"),
      node("x2", "x", "user", "left other"),
      node("y", "u1", "user", "right"),
    ];
    expect(drawn(nested, "x2")).toEqual([
      "▌ root",
      "├─ ▌ left",
      "│  ├─ ▌ left other ·here",
      "│  └─ ▌ left again",
      "└─ ▌ right",
    ]);
  });

  test("says what summaries, commands and images are", () => {
    const kinds = [
      node("c", null, "compaction", "", { tokens: 12_000 }),
      node("s", "c", "branch", "Tried the cache.\nThen gave up."),
      node("b", "s", "bash", "make test"),
      node("i", "b", "user", ""),
      node("x", "i", "custom", "plan: 1. read"),
    ];
    expect(drawn(kinds, "x").map((row) => row.slice(row.indexOf(" ") + 1))).toEqual([
      "compaction of 12,000 tokens",
      "branch summary · Tried the cache.",
      "make test",
      "an image",
      "plan: 1. read ·here",
    ]);
  });

  test("a long chain draws without running out of stack", () => {
    const chain = Array.from({ length: 50_000 }, (_, index) =>
      node(
        `n${index}`,
        index === 0 ? null : `n${index - 1}`,
        index % 2 ? "assistant" : "user",
        `step ${index}`,
      ),
    );
    expect(treeRows(chain, "n49999", NOW).items).toHaveLength(50_000);
  });
});
