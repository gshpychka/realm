import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { collectEvidence } from "@probabench/domain";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/TestClock";
import type { BenchPlan } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { chatEndpoint, withApiKey } from "../sampling/testing";
import { CloudHistory, CloudHistoryError } from "../store/cloud-history";
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
  it.effect("projects observed charges and counts billed replies when uploads fail", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const paused = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let aReplies = 0;
        let bReplies = 0;
        const endpoint = chatEndpoint({
          reply: (body) => {
            const a = body.model === "vendor/a";
            const number = a ? ++aReplies : ++bReplies;
            const response = Effect.succeed(
              Response.json({
                choices: [{ message: { content: a && number === 1 ? "invalid" : "1" } }],
                usage: {
                  cost: a ? (number <= 5 ? 0.012 : 0.024) : number === 10 ? "unavailable" : 0,
                  cost_details: { upstream_inference_cost: 999 },
                },
              }),
            );
            return a && number === 6
              ? Deferred.succeed(paused, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(response),
                )
              : response;
          },
        });
        const output: string[] = [];
        const console = yield* Console.consoleWith(Effect.succeed);
        const capture = Console.withConsole({
          ...console,
          log: (...args: readonly unknown[]) =>
            Effect.sync(() => {
              output.push(args.join(" "));
            }),
        });
        yield* Effect.gen(function* () {
          const plan = planFor(path, "vendor/a", "vendor/b");
          const fiber = yield* Effect.fork(
            executePlan({ ...plan, options: { ...plan.options, trialsPerStep: 5 } }).pipe(capture),
          );
          yield* Deferred.await(paused);
          yield* TestClock.adjust("1 minute");
          expect(output.at(-1)).toContain("[vendor/a] 5/10 saved  Cost $0.06  Est. total $0.12");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fiber);
          const complete = output.at(-1) ?? "";
          expect(complete).toContain("Cost ≥$0.18  Est. total $0.18");
          expect(complete).toContain("[vendor/a] 10/10 saved  Cost $0.18  Est. total $0.18");
          expect(complete).toContain("[vendor/b] 10/10 saved  Cost --  Est. total $0.00");
          expect(complete).toContain("Cost missing for 1 reply.");
          const cloud = yield* CloudHistory;
          yield* Effect.flip(executePlan(planFor(`${path}.failure`, "vendor/a"))).pipe(
            Effect.provideService(CloudHistory, {
              ...cloud,
              append: (runs) =>
                runs.length > 0
                  ? Effect.fail(new CloudHistoryError({ message: "Upload unavailable" }))
                  : Effect.void,
            }),
            capture,
          );
          expect(output.at(-1)).toContain("[vendor/a] 0/2 saved  Cost $0.02  Est. total --");
        }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
      }),
    ),
  );

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

  it.effect("resumes different model targets while sharing the concurrency ceiling", () =>
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
        const modelOptions = new Map([
          ["vendor/a", { trialsPerStep: 6, stepPercent: 50 }],
          ["vendor/b", { trialsPerStep: 4, stepPercent: 25 }],
          ["vendor/c", { trialsPerStep: 3, stepPercent: 100 }],
        ]);
        const mixed = { ...plan, options: { ...plan.options, concurrency: 3 }, modelOptions };
        yield* executePlan(mixed);
        expect(peak).toBe(3);
        expect(modelsOverlap).toBe(true);
        expect(active).toBe(0);
        expect(endpoint.requests).toHaveLength(44);
        const { runs } = yield* readResults(path);
        const evidence = collectEvidence(runs);
        expect(evidence).toHaveLength(3);
        const byModel = new Map(evidence.map((model) => [model.model, model]));
        expect(byModel.get("vendor/a")?.points.map((point) => point.total)).toEqual([6, 6, 6]);
        expect(byModel.get("vendor/b")?.points.map((point) => point.total)).toEqual([
          4, 4, 4, 4, 4,
        ]);
        expect(byModel.get("vendor/c")?.points.map((point) => point.total)).toEqual([3, 3]);
        yield* executePlan(mixed);
        expect(endpoint.requests).toHaveLength(44);
        modelOptions.set("vendor/b", { trialsPerStep: 5, stepPercent: 25 });
        yield* executePlan(mixed);
        expect(endpoint.requests).toHaveLength(49);
        const updated = yield* readResults(path);
        expect(updated.runs.slice(0, runs.length)).toEqual(runs);
        expect(updated.runs.slice(runs.length).every((record) => record.model === "vendor/b")).toBe(
          true,
        );
        expect(
          collectEvidence(updated.runs)
            .find((model) => model.model === "vendor/b")
            ?.points.map((point) => point.total),
        ).toEqual([5, 5, 5, 5, 5]);
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
        expect(yield* fs.readFileString(path)).toBe("not json");
      }).pipe(Effect.provide(endpoint.layer), withApiKey("sk-test"));
    }),
  );
});
