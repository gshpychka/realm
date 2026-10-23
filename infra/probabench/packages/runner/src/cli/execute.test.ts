import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type { BenchPlan } from "../plan/plan";
import type { BenchTarget } from "../plan/targets";
import { chatEndpoint } from "../sampling/testing";
import { ResultsStore } from "../store/results-store";
import { withResultsStore } from "../store/testing";
import { executePlan } from "./execute";

const target = (slug: string): BenchTarget => ({ id: slug, slug, reasoning: "off" });

/** One sample at 0% and one at 100% for each slug, appended to `out`. */
const planFor = (out: string, first: string, ...rest: string[]): BenchPlan => ({
  targets: [target(first), ...rest.map(target)],
  options: { trialsPerStep: 1, stepPercent: 100, concurrency: 1, maxTokens: 4096 },
  out,
});

const withKey = (key?: string) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map(key === undefined ? [] : [["OPENROUTER_API_KEY", key]])),
  );

describe("executePlan", () => {
  it.effect("appends a run per target through the real adapter, keeping earlier runs", () =>
    withResultsStore((path) => {
      const endpoint = chatEndpoint();
      return Effect.gen(function* () {
        yield* executePlan(planFor(path, "vendor/a", "vendor/b"));
        yield* executePlan(planFor(path, "vendor/a"));
        const { runs } = yield* Effect.flatMap(ResultsStore, (store) => store.load(path));
        expect(runs.map((run) => run.modelSlug)).toEqual(["vendor/a", "vendor/b", "vendor/a"]);
        expect(new Set(runs.map((run) => run.id)).size).toBe(3);
        expect(endpoint.requests).toHaveLength(6);
      }).pipe(Effect.provide(endpoint.layer), withKey("sk-test"));
    }),
  );

  it.effect("keeps completed runs when a later target fails", () =>
    withResultsStore((path) => {
      const endpoint = chatEndpoint({ unauthorized: ["vendor/b"] });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(executePlan(planFor(path, "vendor/a", "vendor/b")));
        expect(error._tag).toBe("LlmError");
        const { runs } = yield* Effect.flatMap(ResultsStore, (store) => store.load(path));
        expect(runs.map((run) => run.modelSlug)).toEqual(["vendor/a"]);
      }).pipe(Effect.provide(endpoint.layer), withKey("sk-test"));
    }),
  );

  it.effect("fails on a missing key before any provider request", () =>
    withResultsStore((path) => {
      const endpoint = chatEndpoint();
      return Effect.gen(function* () {
        const error = yield* Effect.flip(executePlan(planFor(path, "vendor/a")));
        expect(error._tag).toBe("MissingApiKey");
        expect(error.message).toContain("secrets/infra/probabench.env");
        expect(endpoint.requests).toHaveLength(0);
      }).pipe(Effect.provide(endpoint.layer), withKey());
    }),
  );

  it.effect("rejects corrupt history before any provider request", () =>
    withResultsStore((path) => {
      const endpoint = chatEndpoint();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "not json");
        const error = yield* Effect.flip(executePlan(planFor(path, "vendor/a")));
        expect(error._tag).toBe("ResultsStoreError");
        expect(endpoint.requests).toHaveLength(0);
      }).pipe(Effect.provide(endpoint.layer), withKey("sk-test"));
    }),
  );
});
