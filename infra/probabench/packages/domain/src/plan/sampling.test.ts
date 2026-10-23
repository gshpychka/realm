import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { Probability, planBudget, probabilityGrid, SAMPLING_PRESETS } from "./sampling";

describe("Probability", () => {
  it.each([0, 0.5, 1])("decodes %d", (value) => {
    expect(Schema.decodeUnknownSync(Probability)(value)).toBe(value);
  });

  it.each([-0.1, 1.5, Number.NaN])("rejects %d", (value) => {
    expect(Either.isLeft(Schema.decodeUnknownEither(Probability)(value))).toBe(true);
  });
});

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

  it("prices each preset per model", () => {
    expect(SAMPLING_PRESETS.map((preset) => planBudget(preset).samples)).toEqual([50, 550, 2100]);
  });
});
