import { expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionSummary } from "./pi-bridge.ts";
import { ago, branchPrompts, forkRows, sessionRows } from "./pi-sessions.ts";

const NOW = Date.parse("2026-11-28T15:00:00");
const at = (minutes: number) => NOW - minutes * 60_000;

/** A session entry; a string message is a prompt the operator sent `minutes` ago. */
function entry(id: string, parentId: string | null, message: string | { role: "assistant" }, minutes = 0) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(at(minutes)).toISOString(),
    message:
      typeof message === "string"
        ? { role: "user", content: [{ type: "text", text: message }], timestamp: at(minutes) }
        : { role: "assistant", content: [], timestamp: at(minutes) },
  } as unknown as SessionEntry;
}

// Two branches share the first prompt: the second was edited into `b2` and the leaf is on it.
const entries = [
  entry("u1", null, "first prompt\nwith detail", 30),
  entry("a1", "u1", { role: "assistant" }, 29),
  entry("u2", "a1", "abandoned prompt", 20),
  entry("a2", "u2", { role: "assistant" }, 19),
  { type: "label", id: "l1", parentId: "a2", timestamp: "", targetId: "u2", label: "old" } as SessionEntry,
  entry("b2", "a1", "edited prompt", 10),
  entry("b3", "b2", { role: "assistant" }, 9),
];

test("prompts come from the current branch only, oldest first", () => {
  const prompts = branchPrompts(entries, "b3");
  expect(prompts.map((prompt) => prompt.entryId)).toEqual(["u1", "b2"]);
  expect(prompts[0]).toEqual({
    entryId: "u1",
    text: "first prompt\nwith detail",
    at: at(30),
  });
  expect(branchPrompts(entries, "a2").map((prompt) => prompt.entryId)).toEqual(["u1", "u2"]);
  expect(branchPrompts(entries, null)).toEqual([]);
  // A parent loop ends the walk rather than the process.
  const loop = [entry("x", "y", "x prompt"), entry("y", "x", "y prompt")];
  expect(branchPrompts(loop, "x").map((prompt) => prompt.entryId)).toEqual(["y", "x"]);
});

test("the fork picker lists prompts newest first by how far back they are", () => {
  expect(forkRows(branchPrompts(entries, "b3"), NOW)).toEqual([
    { label: "edited prompt", detail: "latest prompt · 14:50", value: "b2" },
    { label: "first prompt", detail: "1 prompt ago · 14:30", value: "u1" },
  ]);
  const yesterday = forkRows([{ entryId: "old", text: "\n  \n", at: at(24 * 60) }], NOW);
  expect(yesterday).toEqual([{ label: "an image", detail: "latest prompt · Nov 27 15:00", value: "old" }]);
});

test("saved sessions are listed most recent first, with each fork under the session it came from", () => {
  const session = (path: string, minutes: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
    path,
    id: path,
    cwd: "/home/me/projects/realm",
    modified: at(minutes),
    prompts: 4,
    first: `${path} prompt`,
    ...extra,
  });
  const sessions = [
    session("root", 60),
    session("fork", 5, { parent: "root", name: "Fork \x1b[31mred\x1b[0m" }),
    session("forkfork", 50, { parent: "fork" }),
    session("orphan", 2, { parent: "gone" }),
    session("newest", 1, { prompts: 1 }),
  ];
  const rows = sessionRows(sessions, { current: "fork", all: false, now: NOW, home: "/home/me" });
  expect(rows.map((row) => row.label)).toEqual([
    "newest prompt",
    "orphan prompt",
    "root prompt",
    "└ Fork red",
    "  └ forkfork prompt",
  ]);
  expect(rows.map((row) => row.detail)).toEqual([
    "1m ago · 1 prompt",
    "2m ago · 4 prompts",
    "1h ago · 4 prompts",
    "5m ago · 4 prompts",
    "50m ago · 4 prompts",
  ]);
  expect(rows.filter((row) => row.current).map((row) => row.value)).toEqual(["fork"]);
  // A renamed session is still found by its first prompt.
  expect(rows[3]?.keywords).toBe("fork prompt");
  const everywhere = sessionRows([session("root", 60)], { all: true, now: NOW, home: "/home/me" });
  expect(everywhere[0]?.detail).toBe("1h ago · 4 prompts · ~/projects/realm");
  // Sessions that fork from each other still show.
  const looped = sessionRows([session("a", 1, { parent: "b" }), session("b", 2, { parent: "a" })], {
    all: false,
    now: NOW,
  });
  expect(looped.map((row) => row.value).toSorted()).toEqual(["a", "b"]);
});

test("ages read in the largest unit that fits, then as a date", () => {
  expect(ago(NOW - 30_000, NOW)).toBe("just now");
  expect(ago(at(59), NOW)).toBe("59m ago");
  expect(ago(at(3 * 60), NOW)).toBe("3h ago");
  expect(ago(at(2 * 24 * 60), NOW)).toBe("2d ago");
  expect(ago(at(10 * 24 * 60), NOW)).toBe("Nov 18");
  expect(ago(Date.parse("2025-06-01T12:00:00"), NOW)).toBe("Jun 1, 2025");
});
