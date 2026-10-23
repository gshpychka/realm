import { describe, expect, it } from "@effect/vitest";
import { benchmarkCommand, parseJob, shellQuote } from "./benchmark";

describe("Benchmark setup", () => {
  it("quotes model and reasoning arguments so copied commands cannot execute their contents", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    const command = benchmarkCommand({
      model: "a'$(touch bad)",
      trialsPerStep: 10,
      stepPercent: 25,
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

const settings = { model: "vendor/model", trialsPerStep: 50, stepPercent: 10, concurrency: 5 };

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
      { trialsPerStep: 0 },
      { trialsPerStep: 10001 },
      { stepPercent: 0 },
      { stepPercent: 101 },
      { stepPercent: 2.5 },
      { concurrency: 0 },
      { concurrency: 51 },
    ])
      expect(validateBenchmarkOptions({ ...settings, ...invalid })).toBeTruthy();
    expect(validateBenchmarkOptions({ ...settings, model: "gpt-5-mini-low" })).toBeNull();
  });

  it("reports the latest finished point and nothing before the first one", () => {
    expect(jobPointProgress("[vendor/model] starting sweep")).toBeNull();
    expect(
      jobPointProgress(
        "[vendor/model] point 1/11 x=0%\n[vendor/model] point 3/11 x=20%\nretrying…",
      ),
    ).toEqual({ completed: 3, total: 11 });
  });
});
