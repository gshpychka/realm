import { describe, expect, it } from "@effect/vitest";
import { planBudget, probabilityGrid } from "./sampling";

describe("probabilityGrid", () => {
  it.each([
    { step: 30, grid: [0, 0.3, 0.6, 0.9, 1] },
    { step: 50, grid: [0, 0.5, 1] },
    { step: 100, grid: [0, 1] },
  ])("includes both endpoints for a $step% step", ({ step, grid }) => {
    expect(probabilityGrid(step)).toEqual(grid);
  });
});

describe("planBudget", () => {
  it("counts both grid endpoints and every retry", () => {
    expect(planBudget({ trialsPerStep: 10, stepPercent: 30 })).toEqual({
      points: 5,
      samples: 50,
      attempts: 300,
    });
    expect(planBudget({ trialsPerStep: 5, stepPercent: 50 }, 3).samples).toBe(45);
  });
});
