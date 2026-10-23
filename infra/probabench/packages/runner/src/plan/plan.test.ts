import { describe, expect, it } from "@effect/vitest";
import { describePlan } from "./plan";

describe("describePlan", () => {
  it("prints every series and what the plan samples across all of them", () => {
    const description = describePlan({
      series: [
        { model: "vendor/a", modelSlug: "vendor/a", reasoning: "off" },
        { model: "vendor/b [reasoning=low]", modelSlug: "vendor/b", reasoning: "low" },
      ],
      options: { trialsPerStep: 5, stepPercent: 50, concurrency: 1, maxTokens: 16 },
      out: "results.json",
    });
    expect(description).toBe(
      [
        "Models (2):",
        "  vendor/a · reasoning off",
        "  vendor/b · reasoning low",
        "Sampling: 5 trials × 3 points (50% step), 1 at a time",
        "Projected samples: 30",
      ].join("\n"),
    );
  });
});
