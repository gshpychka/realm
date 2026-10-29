import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { collectEvidence } from "@probabench/domain";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/TestClock";
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
  it.effect("fills only missing daily slots while preserving earlier checkpoints", () =>
    withHistoryFile((path) => {
      const endpoint = chatEndpoint({
        reply: (_, index) =>
          Effect.succeed(
            index === 1
              ? new Response(JSON.stringify({ choices: [{ message: { content: "not a bit" } }] }), {
                  headers: { "content-type": "application/json" },
                })
              : undefined,
          ),
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const plan = planFor(path, "vendor/a");
        const collect = (trialsPerStep: number, stepPercent: number) =>
          executePlan({
            ...plan,
            options: { ...plan.options, trialsPerStep, stepPercent, concurrency: 8 },
          });
        yield* collect(2, 50);
        expect(endpoint.requests).toHaveLength(6);
        const initial = yield* readResults(path);
        const originalBytes = yield* fs.readFileString(path);
        // A no-op neither needs a key nor rewrites the saved data; invalid answers fill slots.
        yield* collect(2, 50).pipe(withApiKey(""));
        expect(endpoint.requests).toHaveLength(6);
        expect(yield* fs.readFileString(path)).toBe(originalBytes);
        yield* collect(5, 50);
        expect(endpoint.requests).toHaveLength(15);
        yield* collect(5, 25);
        expect(endpoint.requests).toHaveLength(25);
        yield* collect(1, 100);
        expect(endpoint.requests).toHaveLength(25);
        const expanded = yield* readResults(path);
        expect(expanded.runs.slice(0, initial.runs.length)).toEqual(initial.runs);
        expect(collectEvidence(expanded.runs)[0]?.points.map(({ total }) => total)).toEqual([
          5, 5, 5, 5, 5,
        ]);
        yield* TestClock.adjust("1 day");
        yield* collect(1, 100);
        expect(endpoint.requests).toHaveLength(27);
        expect(collectEvidence((yield* readResults(path)).runs)[0]?.summary.total).toBe(27);
      }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
    }),
  );

  it.effect("keeps answers from an interrupted benchmark and resumes without repeating them", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const stalled = yield* Deferred.make<void>();
        const endpoint = chatEndpoint({
          reply: (_, index) =>
            index === 2
              ? Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(undefined),
        });
        yield* Effect.gen(function* () {
          const plan = planFor(path, "vendor/a");
          const request = { ...plan, options: { ...plan.options, trialsPerStep: 2 } };
          const fiber = yield* Effect.fork(executePlan(request));
          yield* Deferred.await(stalled);
          yield* Fiber.interrupt(fiber);
          const partial = yield* readResults(path);
          expect(collectEvidence(partial.runs)[0]?.summary.total).toBe(1);
          yield* executePlan(request);
          const complete = yield* readResults(path);
          expect(complete.runs.slice(0, partial.runs.length)).toEqual(partial.runs);
          expect(collectEvidence(complete.runs)[0]?.summary.total).toBe(4);
          expect(endpoint.requests).toHaveLength(5); // Four replies plus the interrupted request.
        }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
      }),
    ),
  );

  it.effect("serializes competing invocations before calculating their daily deficits", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const endpoint = chatEndpoint({
          reply: (_, index) =>
            index === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.as(undefined),
                )
              : Effect.succeed(undefined),
        });
        yield* Effect.gen(function* () {
          const plan = planFor(path, "vendor/a");
          const first = yield* Effect.fork(executePlan(plan));
          yield* Deferred.await(started);
          const second = yield* Effect.fork(executePlan(plan));
          yield* TestClock.adjust("1 second");
          expect(endpoint.requests).toHaveLength(1);
          yield* Deferred.succeed(proceed, undefined);
          yield* Fiber.join(first);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(second);
          expect(endpoint.requests).toHaveLength(2);
          expect(collectEvidence((yield* readResults(path)).runs)[0]?.summary.total).toBe(2);
        }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
      }),
    ),
  );

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
        const evidence = collectEvidence(runs);
        expect(evidence).toHaveLength(3);
        for (const model of evidence)
          expect(model.points.map((point) => point.total)).toEqual([6, 6, 6]);
      }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
    }),
  );

  it.effect("finishes and saves healthy models when another model fails", () =>
    withHistoryFile((path) => {
      const endpoint = chatEndpoint({ unauthorized: ["vendor/b"] });
      return Effect.gen(function* () {
        yield* Effect.flip(executePlan(planFor(path, "vendor/a", "vendor/b")));
        const { runs } = yield* readResults(path);
        expect([...new Set(runs.map((run) => run.modelSlug))]).toEqual(["vendor/a"]);
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
