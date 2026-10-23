import { describe, expect, test } from "bun:test";
import { fresh, newer, older, prompts } from "./history.ts";

const entries = ["first", "second", "third"];

describe("history", () => {
  test("steps back from the newest prompt to the oldest and stops there", () => {
    let recall = fresh;
    const seen: string[] = [];
    for (;;) {
      const step = older(recall, entries, "draft");
      if (!step) break;
      recall = step.recall;
      seen.push(step.text);
    }
    expect(seen).toEqual(["third", "second", "first"]);
  });

  test("stepping forward past the newest brings back the draft", () => {
    const back = older(fresh, entries, "half typed");
    expect(back?.text).toBe("third");
    const forward = back ? newer(back.recall, entries) : null;
    expect(forward?.text).toBe("half typed");
    expect(forward?.recall).toEqual(fresh);
  });

  test("stepping forward with the draft showing does nothing", () => {
    expect(newer(fresh, entries)).toBeNull();
  });

  test("an empty history has nothing to step back to", () => {
    expect(older(fresh, [], "x")).toBeNull();
  });

  test("blank prompts and back-to-back repeats are left out", () => {
    expect(prompts(["a", "a", " ", "b", "a"])).toEqual(["a", "b", "a"]);
  });
});
