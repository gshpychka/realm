import { describe, expect, test } from "bun:test";
import { checkAll, clearAll, ordered, reorder, toggle } from "./checklist.ts";

const all = ["a", "b", "c"];

describe("checklist", () => {
  test("clearing one of every item checks the rest, and checking it back checks every item", () => {
    const some = toggle(null, all, "b");
    expect(some).toEqual(["a", "c"]);
    expect(toggle(some, all, "b")).toBeNull();
  });

  test("clears and checks only the targets while a filter narrows the list", () => {
    expect(clearAll(null, all, ["a", "b"])).toEqual(["c"]);
    expect(checkAll(["c"], all, ["a"])).toEqual(["c", "a"]);
    expect(checkAll(["c"], all)).toBeNull();
    expect(clearAll(null, all)).toEqual([]);
  });

  test("lists checked items in their order first, and moves one within that order", () => {
    expect(ordered(["c", "a"], all)).toEqual(["c", "a", "b"]);
    expect(reorder(["c", "a"], "a", -1)).toEqual(["a", "c"]);
    expect(reorder(["c", "a"], "c", -1)).toEqual(["c", "a"]);
    expect(reorder(null, "a", 1)).toBeNull();
  });

  test("keeps a checked value that matches no item", () => {
    expect(toggle(["gone"], all, "a")).toEqual(["gone", "a"]);
    expect(ordered(["gone"], all)).toEqual(["gone", "a", "b", "c"]);
  });
});
