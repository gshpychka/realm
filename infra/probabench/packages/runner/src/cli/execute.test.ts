import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { BenchPlan } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { chatEndpoint, withApiKey } from "../sampling/testing";
import { readResults, withHistoryFile } from "../store/testing";
import { executePlan } from "./execute";

const seriesFor = (slug: string): ModelSeries => ({
  model: slug,
  modelSlug: slug,
  reasoning: "off",
});

/** One sample at 0% and one at 100% for each slug, appended to `out`. */
const planFor = (out: string, first: string, ...rest: string[]): BenchPlan => ({
  series: [seriesFor(first), ...rest.map(seriesFor)],
  options: { trialsPerStep: 1, stepPercent: 100, concurrency: 1, maxTokens: 4096 },
  out,
});

describe("executePlan", () => {
  it.effect("overlaps models through the HTTP adapter without multiplying the ceiling", () =>
    withHistoryFile((path) => {
      let active = 0;
      let peak = 0;
      const inFlight = new Map<string, number>();
      let modelsOverlap = false;
      const endpoint = chatEndpoint({
        reply: (body) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active++;
              peak = Math.max(peak, active);
              const model = String(body.model);
              inFlight.set(model, (inFlight.get(model) ?? 0) + 1);
              modelsOverlap ||= [...inFlight.values()].filter((n) => n > 0).length > 1;
            }),
            () => Effect.yieldNow().pipe(Effect.as(undefined)),
            () =>
              Effect.sync(() => {
                active--;
                const model = String(body.model);
                inFlight.set(model, (inFlight.get(model) ?? 0) - 1);
              }),
          ),
      });
      return Effect.gen(function* () {
        const plan = planFor(path, "vendor/a", "vendor/b", "vendor/c");
        yield* executePlan({
          ...plan,
          options: { ...plan.options, trialsPerStep: 6, stepPercent: 50, concurrency: 3 },
        });
        expect(peak).toBe(3);
        expect(modelsOverlap).toBe(true);
        expect(active).toBe(0);
        expect(endpoint.requests).toHaveLength(54);
        const { runs } = yield* readResults(path);
        expect(runs).toHaveLength(3);
        for (const run of runs)
          expect(run.points.map((point) => point.outcomes.length)).toEqual([6, 6, 6]);
      }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
    }),
  );

  it.effect("finishes and saves healthy models when another model fails", () =>
    withHistoryFile((path) => {
      const endpoint = chatEndpoint({ unauthorized: ["vendor/b"] });
      return Effect.gen(function* () {
        yield* Effect.flip(executePlan(planFor(path, "vendor/a", "vendor/b")));
        const { runs } = yield* readResults(path);
        expect(runs.map((run) => run.modelSlug)).toEqual(["vendor/a"]);
      }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
    }),
  );

  it.effect("rejects corrupt history before any provider request", () =>
    withHistoryFile((path) => {
      const endpoint = chatEndpoint();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "not json");
        yield* Effect.flip(executePlan(planFor(path, "vendor/a")));
        expect(endpoint.requests).toHaveLength(0);
      }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
    }),
  );
});
