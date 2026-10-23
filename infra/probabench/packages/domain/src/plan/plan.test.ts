import { describe, expect, it } from "@effect/vitest";
import { planBudget, SAMPLING_PRESETS } from "./plan";

describe("planBudget", () => {
  it("counts both grid endpoints and every retry", () => {
    expect(planBudget({ trialsPerStep: 10, stepPercent: 30 })).toEqual({
      points: 5,
      samples: 50,
      attempts: 300,
    });
    expect(planBudget({ trialsPerStep: 5, stepPercent: 50 }, 3).samples).toBe(45);
  });

  it("prices each preset per model", () => {
    expect(SAMPLING_PRESETS.map((preset) => planBudget(preset).samples)).toEqual([50, 550, 2100]);
  });
});
