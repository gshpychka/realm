import { describe, expect, test } from "bun:test";
import { DEFAULT_KEYS, moveFor } from "./keys.ts";

describe("the keys bound by default", () => {
  test("arrows walk", () => {
    expect(moveFor("left")).toEqual({ walk: "west" });
    expect(moveFor("right")).toEqual({ walk: "east" });
    expect(moveFor("up")).toEqual({ walk: "north" });
    expect(moveFor("down")).toEqual({ walk: "south" });
  });

  test("hjkl walk the same way", () => {
    expect(moveFor("h")).toEqual({ walk: "west" });
    expect(moveFor("l")).toEqual({ walk: "east" });
    expect(moveFor("k")).toEqual({ walk: "north" });
    expect(moveFor("j")).toEqual({ walk: "south" });
  });

  test("the scale has a key each way, and every alias lands", () => {
    for (const name of DEFAULT_KEYS.widen) expect(moveFor(name)).toEqual({ scale: "widen" });
    for (const name of DEFAULT_KEYS.close) expect(moveFor(name)).toEqual({ scale: "close" });
  });

  test("an unbound key does nothing", () => {
    expect(moveFor("q")).toBe(null);
    expect(moveFor("")).toBe(null);
    expect(moveFor("escape")).toBe(null);
  });
});

describe("bindings the caller supplies", () => {
  test("one action rebound leaves the rest on their defaults", () => {
    const keys = { west: ["a"] };
    expect(moveFor("a", { keys })).toEqual({ walk: "west" });
    expect(moveFor("left", { keys })).toBe(null);
    expect(moveFor("l", { keys })).toEqual({ walk: "east" });
  });

  test("an action bound to nothing is unreachable, and the others stand", () => {
    const keys = { widen: [] };
    expect(moveFor("-", { keys })).toBe(null);
    expect(moveFor("z", { keys })).toBe(null);
    expect(moveFor("+", { keys })).toEqual({ scale: "close" });
  });

  test("keys false binds no action at all", () => {
    for (const name of ["left", "h", "j", "-", "+", "return"]) {
      expect(moveFor(name, { keys: false })).toBe(null);
    }
  });

  test("one key may be bound to two actions, and the first listed wins", () => {
    // Both take "x"; the order is the order the actions are tried.
    expect(moveFor("x", { keys: { north: ["x"], south: ["x"] } })).toEqual({ walk: "north" });
    expect(moveFor("x", { keys: { south: ["x"], widen: ["x"] } })).toEqual({ walk: "south" });
  });
});

describe("keys that reach a pane", () => {
  test("a jump names the pane it reaches", () => {
    expect(moveFor("2", { jumps: { "2": "intake" } })).toEqual({ reach: "intake" });
  });

  test("a jump beats a default, so any key can be spent on a pane", () => {
    expect(moveFor("j", { jumps: { j: "questions" } })).toEqual({ reach: "questions" });
    expect(moveFor("return", { jumps: { return: "talk" } })).toEqual({ reach: "talk" });
  });

  test("jumps stand while keys false silences the walk", () => {
    const bindings = { keys: false as const, jumps: { "1": "hub" } };
    expect(moveFor("1", bindings)).toEqual({ reach: "hub" });
    expect(moveFor("h", bindings)).toBe(null);
  });

  test("a key outside the jumps falls through to the actions", () => {
    const bindings = { jumps: { "1": "hub" } };
    expect(moveFor("h", bindings)).toEqual({ walk: "west" });
  });

  test("a jump to a pane id nothing holds is still the move; the lattice refuses it", () => {
    expect(moveFor("9", { jumps: { "9": "nowhere" } })).toEqual({ reach: "nowhere" });
  });
});
