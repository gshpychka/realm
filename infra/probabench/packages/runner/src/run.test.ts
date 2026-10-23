import * as AiError from "@effect/ai/AiError";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Benchmark } from "./benchmark";
import { LlmError } from "./bit-sampler";
import type { SamplingOptions } from "./plan";
import type { BenchTarget } from "./registry";
import { ResultsStore } from "./results-store";
import { executePlan, sweepAll } from "./run";
import { chatEndpoint, withResultsStore } from "./test-fixtures";

const target = (id: string): BenchTarget => ({ id, slug: id, reasoning: "off" });
const SWEEP_OPTIONS: SamplingOptions = {
  trialsPerStep: 1,
  stepPercent: 100,
  maxTokens: 4096,
  concurrency: 1,
};
const execute = (path: string, targets: readonly [BenchTarget, ...BenchTarget[]]) =>
  executePlan({ targets, options: SWEEP_OPTIONS, out: path }).pipe(
    Effect.provide(Benchmark.Default),
    Effect.provide(FetchHttpClient.layer),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
  );

describe("sweepAll", () => {
  it.effect("appends independent repeated model runs and preserves siblings", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const original = makeRun({ model: "haiku" });
        const sibling = makeRun({ model: "mini" });
        yield* sweepAll([target("haiku"), target("mini")], path, (t) =>
          Effect.succeed(t.id === "haiku" ? original : sibling),
        );
        const repeated = makeRun({ model: "haiku" });
        yield* sweepAll([target("haiku")], path, () => Effect.succeed(repeated));
        const store = yield* ResultsStore;
        expect((yield* store.load(path)).runs).toEqual([original, sibling, repeated]);
      }),
    ),
  );

  it.effect("keeps completed targets when a later provider fails", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const failure = new LlmError({
          cause: new AiError.MalformedOutput({ module: "test", method: "sample" }),
        });
        const error = yield* Effect.flip(
          sweepAll([target("first"), target("second")], path, (t) =>
            t.id === "first" ? Effect.succeed(makeRun({ model: t.id })) : Effect.fail(failure),
          ),
        );
        expect(error).toBe(failure);
        const store = yield* ResultsStore;
        expect((yield* store.load(path)).runs.map((run) => run.model)).toEqual(["first"]);
      }),
    ),
  );

  it.effect("rejects corrupt prior results before sampling", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "not json");
        let calls = 0;
        const error = yield* Effect.flip(
          sweepAll([target("haiku")], path, (t) =>
            Effect.sync(() => {
              calls++;
              return makeRun({ model: t.id });
            }),
          ),
        );
        expect(error._tag).toBe("ResultsStoreError");
        expect(calls).toBe(0);
      }),
    ),
  );
});

describe("OpenRouter execution preflight", () => {
  it.effect("fails with a clear missing API key before provider requests", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(execute(path, [target("vendor/model")]));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
          "OPENROUTER_API_KEY",
        );
      }),
    ),
  );
  it.effect("executes and appends repeated runs for any slug through the real adapter", () =>
    withResultsStore((path) => {
      const endpoint = chatEndpoint("1");
      return Effect.gen(function* () {
        const plan = {
          targets: [target("vendor/future-model")],
          options: SWEEP_OPTIONS,
          out: path,
        } as const;
        yield* executePlan(plan);
        yield* executePlan(plan);
        const store = yield* ResultsStore;
        const results = yield* store.load(path);
        expect(results.runs).toHaveLength(2);
        expect(new Set(results.runs.map((run) => run.id)).size).toBe(2);
        expect(results.runs.map((run) => run.modelSlug)).toEqual([
          "vendor/future-model",
          "vendor/future-model",
        ]);
        expect(results.runs.map((run) => run.reasoning)).toEqual(["off", "off"]);
        expect(endpoint.requests).toHaveLength(4);
      }).pipe(
        Effect.provide(Benchmark.Default),
        Effect.provide(endpoint.layer),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["OPENROUTER_API_KEY", "test"]])),
        ),
      );
    }),
  );
});
