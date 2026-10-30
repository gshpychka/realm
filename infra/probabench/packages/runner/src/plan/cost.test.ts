import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { costForDaily } from "./cost";
import { planDaily } from "./daily";
import type { BenchPlan } from "./plan";

const today = "2026-10-29T12:00:00.000Z";
const low = makeRun({
  reasoning: "low",
  startedAt: today,
  points: [
    { x: 0, outcomes: [{ invalidText: "?" }] },
    { x: 1, outcomes: [1] },
  ],
});
const off = makeRun({ startedAt: today });
const plan: BenchPlan = {
  series: [low, off],
  options: { trialsPerStep: 2, stepPercent: 50, maxTokens: 128, concurrency: 8 },
  out: "unused",
};
const price = {
  id: "vendor/model",
  pricing: { prompt: "0.000002", completion: "0.000008", request: "0.001" },
};

describe("cost estimation", () => {
  it("prices only missing daily answers, with separate reasoning budgets and per-request fees", () => {
    const yesterday = makeRun({ reasoning: "low", startedAt: "2026-10-28T12:00:00.000Z" });
    const daily = planDaily(plan, { runs: [low, off, yesterday] }, today);
    const estimate = costForDaily(daily, { fetchedAt: today, data: [price], warning: null });
    // Four low-reasoning requests and two nonreasoning requests remain. Each
    // prompt is estimated at 63 tokens; output scenarios are 1–128 and 1–16.
    expect(estimate.requests).toBe(6);
    expect(estimate.cost?.low).toBeCloseTo(0.006804, 9);
    expect(estimate.cost?.high).toBeCloseTo(0.011108, 9);
  });

  it("does not present a partial subtotal as the price when another model has unusable pricing", () => {
    const unpriced = makeRun({ modelSlug: "vendor/unpriced" });
    const mixed = { ...plan, series: [low, unpriced] as const };
    const estimate = costForDaily(planDaily(mixed, { runs: [] }, today), {
      fetchedAt: today,
      warning: null,
      data: [price, { id: "vendor/unpriced", pricing: { prompt: "-1", completion: "0" } }],
    });
    expect(estimate.models[0]?.cost).not.toBeNull();
    expect(estimate.models[1]?.cost).toBeNull();
    expect(estimate.cost).toBeNull();
  });
});
