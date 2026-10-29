import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { estimateCost } from "./cost";
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
const catalog = (data: readonly unknown[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ data }))),
    ),
  );
const price = {
  id: "vendor/model",
  pricing: { prompt: "0.000002", completion: "0.000008", request: "0.001" },
};

describe("cost estimation", () => {
  it.effect(
    "prices only missing daily answers, with separate reasoning budgets and per-request fees",
    () =>
      Effect.gen(function* () {
        const yesterday = makeRun({ reasoning: "low", startedAt: "2026-10-28T12:00:00.000Z" });
        const daily = planDaily(plan, { runs: [low, off, yesterday] }, today);
        const estimate = yield* estimateCost(daily, plan.options);
        // Four low-reasoning requests and two nonreasoning requests remain. Each
        // prompt is estimated at 63 tokens; output scenarios are 1–128 and 1–16.
        expect(estimate.requests).toBe(6);
        expect(estimate.cost?.low).toBeCloseTo(0.006804, 9);
        expect(estimate.cost?.high).toBeCloseTo(0.011108, 9);
      }).pipe(Effect.provide(catalog([price]))),
  );

  it.effect(
    "does not present a partial subtotal as the price when another model has unusable pricing",
    () =>
      Effect.gen(function* () {
        const unpriced = makeRun({ modelSlug: "vendor/unpriced" });
        const mixed = { ...plan, series: [low, unpriced] as const };
        const estimate = yield* estimateCost(planDaily(mixed, { runs: [] }, today), mixed.options);
        expect(estimate.models[0]?.cost).not.toBeNull();
        expect(estimate.models[1]?.cost).toBeNull();
        expect(estimate.cost).toBeNull();
      }).pipe(
        Effect.provide(
          catalog([price, { id: "vendor/unpriced", pricing: { prompt: "-1", completion: "0" } }]),
        ),
      ),
  );
});
