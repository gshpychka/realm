import { describe, expect, it } from "@effect/vitest";
import { benchmarkCommand, parseJob, sampleBudget, shellQuote } from "./benchmark";

describe("Benchmark setup", () => {
  it("includes both endpoints in non-divisor grids and counts retry attempts", () => {
    expect(sampleBudget(10, 30)).toEqual({ targets: 5, samples: 50, attempts: 300 });
    expect(sampleBudget(50, 10)).toEqual({ targets: 11, samples: 550, attempts: 3300 });
    expect(sampleBudget(0, 10)).toEqual({ targets: 0, samples: 0, attempts: 0 });
    expect(sampleBudget(2, 0)).toEqual({ targets: 0, samples: 0, attempts: 0 });
  });
  it("quotes model and reasoning arguments so copied commands cannot execute their contents", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    const command = benchmarkCommand({
      model: "a'$(touch bad)",
      trials: 10,
      step: 25,
      concurrency: 5,
    });
    expect(command).toContain("--model 'a'\\''$(touch bad)'");
    expect(command).not.toContain("--yes");
  });
  it("rejects malformed bridge job responses", () => {
    expect(parseJob({ id: "a", status: "unknown", startedAt: "today", log: "" })).toBeNull();
    expect(
      parseJob({
        id: "a",
        status: "running",
        startedAt: "2026-10-22T00:00:00.000Z",
        log: "Preparing",
      })?.status,
    ).toBe("running");
  });
});

import { jobPointProgress, validateBenchmarkOptions } from "./benchmark";

const settings = { model: "vendor/model", trials: 50, step: 10, concurrency: 5 };

describe("setup request boundaries", () => {
  it("matches local API model and numeric limits before a user can submit", () => {
    expect(validateBenchmarkOptions(settings)).toBeNull();
    expect(
      validateBenchmarkOptions({ ...settings, model: `vendor/${"a".repeat(193)}` }),
    ).toBeNull();
    for (const invalid of [
      { model: `vendor/${"a".repeat(194)}` },
      { model: "all" },
      { model: "future-model" },
      { model: "vendor/model+variant" },
      { model: "vendor/model with spaces" },
      { trials: 0 },
      { trials: 10001 },
      { step: 0 },
      { step: 101 },
      { step: 2.5 },
      { concurrency: 0 },
      { concurrency: 51 },
    ])
      expect(validateBenchmarkOptions({ ...settings, ...invalid })).toBeTruthy();
    expect(validateBenchmarkOptions({ ...settings, model: "gpt-5-mini-low" })).toBeNull();
  });

  it("does not present unsafe-integer sample projections", () => {
    expect(sampleBudget(Number.MAX_SAFE_INTEGER, 1)).toEqual({
      targets: 0,
      samples: 0,
      attempts: 0,
    });
  });

  it("summarizes live probability progress without inventing progress before the first point", () => {
    expect(jobPointProgress("[vendor/model] starting sweep")).toBeNull();
    expect(
      jobPointProgress(
        "[vendor/model] point 1/11 x=0%\n[vendor/model] point 3/11 x=20%\nretrying…",
      ),
    ).toEqual({ completed: 3, total: 11 });
    expect(jobPointProgress("[vendor/model [reasoning=low]] point 2/5 x=25%")).toEqual({
      completed: 2,
      total: 5,
    });
    expect(jobPointProgress("[vendor/model] point 99/5 x=25%")).toBeNull();
  });
});
