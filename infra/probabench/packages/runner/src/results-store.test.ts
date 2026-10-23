import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { Probability, type Results, type Run } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ResultsStore, SCHEMA_VERSION } from "./results-store";
import { withResultsStore } from "./test-fixtures";

const makeRun = (model: string, startedAt = "2026-06-26T00:00:00.000Z"): Run => ({
  id: randomUUID(),
  model,
  trialsPerStep: 2,
  stepPercent: 100,
  startedAt,
  points: [{ x: Probability.make(0.5), outcomes: [1, 0] }],
});

describe("ResultsStore", () => {
  it.effect("loads an empty Results from a missing path", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const store = yield* ResultsStore;
        expect(yield* store.load(path)).toEqual({
          schemaVersion: SCHEMA_VERSION,
          runs: [],
        } satisfies Results);
      }),
    ),
  );

  it.effect("round-trips through a flushed atomic save and cleans up temporary files", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const store = yield* ResultsStore;
        const fs = yield* FileSystem.FileSystem;
        const results: Results = { schemaVersion: SCHEMA_VERSION, runs: [makeRun("haiku")] };
        yield* store.save(path, results);
        expect(yield* store.load(path)).toEqual(results);
        expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
      }),
    ),
  );

  it.effect("preserves repeated model history as independent execution ids", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const store = yield* ResultsStore;
        const sibling = makeRun("sonnet");
        const original = makeRun("haiku");
        yield* store.save(path, {
          schemaVersion: SCHEMA_VERSION,
          runs: [original, sibling],
        });
        const replacement = makeRun("haiku", "2026-06-26T02:00:00.000Z");
        const appended = yield* store.append(path, replacement);
        expect(appended.runs).toEqual([original, sibling, replacement]);
        const added = makeRun("mini");
        yield* store.append(path, added);
        expect((yield* store.load(path)).runs).toEqual([original, sibling, replacement, added]);
      }),
    ),
  );

  it.effect("serializes concurrent read-modify-write merges without losing runs", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const store = yield* ResultsStore;
        yield* Effect.forEach(
          Array.from({ length: 10 }, (_, i) => i),
          (i) => store.append(path, makeRun(`model-${i}`)),
          {
            concurrency: "unbounded",
          },
        );
        expect((yield* store.load(path)).runs.map((run) => run.model).sort()).toEqual(
          Array.from({ length: 10 }, (_, i) => `model-${i}`),
        );
      }),
    ),
  );

  it.effect(
    "preserves the previous document and removes staging files when replacement fails",
    () =>
      withResultsStore((path) =>
        Effect.gen(function* () {
          const originalStore = yield* ResultsStore;
          const fs = yield* FileSystem.FileSystem;
          const original: Results = { schemaVersion: SCHEMA_VERSION, runs: [makeRun("original")] };
          yield* originalStore.save(path, original);
          const failingFs = Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            rename: () =>
              Effect.fail(
                new PlatformError.SystemError({
                  module: "FileSystem",
                  method: "rename",
                  reason: "PermissionDenied",
                }),
              ),
          });
          const failure = yield* Effect.flip(
            Effect.flatMap(ResultsStore, (store) =>
              store.save(path, { schemaVersion: SCHEMA_VERSION, runs: [makeRun("new")] }),
            ).pipe(Effect.provide(ResultsStore.Default.pipe(Layer.provide(failingFs)))),
          );
          expect(failure._tag).toBe("ResultsStoreError");
          expect(yield* originalStore.load(path)).toEqual(original);
          expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
        }),
      ),
  );

  it.effect("reports corrupt JSON and leaves it intact", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        yield* fs.writeFileString(path, "{broken");
        expect((yield* Effect.flip(store.append(path, makeRun("haiku"))))._tag).toBe(
          "ResultsStoreError",
        );
        expect(yield* fs.readFileString(path)).toBe("{broken");
      }),
    ),
  );
});

it.effect("prepares a missing output without creating a document or leaving staging files", () =>
  withResultsStore((path) =>
    Effect.gen(function* () {
      const store = yield* ResultsStore;
      const fs = yield* FileSystem.FileSystem;
      yield* store.prepare(path);
      expect(yield* fs.exists(path)).toBe(false);
      expect(yield* fs.readDirectory(dirname(path))).toEqual([]);
    }),
  ),
);

it.effect("loads v1 history and appends a new run without losing or changing legacy data", () =>
  withResultsStore((path) =>
    Effect.gen(function* () {
      const store = yield* ResultsStore;
      const fs = yield* FileSystem.FileSystem;
      const { id: _id, ...legacy } = makeRun("legacy-model");
      yield* fs.writeFileString(path, JSON.stringify({ schemaVersion: 1, runs: [legacy] }));
      const loaded = yield* store.load(path);
      expect(loaded.schemaVersion).toBe(2);
      expect(loaded.runs[0]?.id).toMatch(/^legacy-v1:/);
      const repeated = makeRun("legacy-model");
      yield* store.append(path, repeated);
      const reloaded = yield* store.load(path);
      expect(reloaded.runs).toEqual([...loaded.runs, repeated]);
      expect(JSON.parse(yield* fs.readFileString(path)).schemaVersion).toBe(2);
      void _id;
    }),
  ),
);

it.effect("rejects duplicate execution ids while preserving the previous document", () =>
  withResultsStore((path) =>
    Effect.gen(function* () {
      const store = yield* ResultsStore;
      const run = makeRun("model");
      yield* store.append(path, run);
      expect((yield* Effect.flip(store.append(path, run)))._tag).toBe("ResultsStoreError");
      expect((yield* store.load(path)).runs).toEqual([run]);
    }),
  ),
);

import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

it.effect(
  "serializes separate store instances so concurrent appends retain every completed run",
  () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const originalStore = yield* ResultsStore;
        const original = makeRun("shared-model");
        yield* originalStore.append(path, original);
        const slowedFs = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) => Effect.sleep("50 millis").pipe(Effect.andThen(fs.rename(from, to))),
        });
        const first = makeRun("shared-model");
        const second = makeRun("shared-model");
        const independentAppend = (run: Run) =>
          Effect.flatMap(ResultsStore, (store) => store.append(path, run)).pipe(
            Effect.provide(ResultsStore.Default.pipe(Layer.provide(slowedFs))),
          );
        yield* Effect.all([independentAppend(first), independentAppend(second)], {
          concurrency: 2,
        });
        const stored = yield* originalStore.load(path);
        expect(stored.runs).toHaveLength(3);
        expect(new Set(stored.runs.map((run) => run.id))).toEqual(
          new Set([original.id, first.id, second.id]),
        );
        expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
      }).pipe(Effect.withClock(Clock.make())),
    ),
);

it.effect("removes its lock and staging files when a writer is interrupted", () =>
  withResultsStore((path) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const originalStore = yield* ResultsStore;
      const original = makeRun("original");
      yield* originalStore.append(path, original);
      const reachedRename = yield* Deferred.make<void>();
      const stalledFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        rename: () => Deferred.succeed(reachedRename, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* Effect.fork(
        Effect.flatMap(ResultsStore, (store) => store.append(path, makeRun("interrupted"))).pipe(
          Effect.provide(ResultsStore.Default.pipe(Layer.provide(stalledFs))),
        ),
      );
      yield* Deferred.await(reachedRename);
      yield* Fiber.interrupt(fiber);
      expect((yield* originalStore.load(path)).runs).toEqual([original]);
      expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
    }),
  ),
);

it.effect(
  "detects an abandoned lock during preflight and never removes another writer's lock",
  () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        const owner = JSON.stringify({ pid: 12345, createdAt: "2026-01-01T00:00:00.000Z" });
        yield* fs.writeFileString(`${path}.lock`, owner);
        const error = yield* Effect.flip(store.prepare(path));
        expect(error.cause._tag).toBe("SystemError");
        expect(error.cause.message).toContain("History is locked by another writer");
        expect(yield* fs.readFileString(`${path}.lock`)).toBe(owner);
        expect(yield* fs.exists(path)).toBe(false);
      }).pipe(Effect.withClock(Clock.make())),
    ),
  10000,
);

it.effect("cancels a waiting writer promptly without deleting the active owner's lock", () =>
  withResultsStore((path) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const attempted = yield* Deferred.make<void>();
      const owner = JSON.stringify({ pid: 12345 });
      yield* fs.writeFileString(`${path}.lock`, owner);
      const observedFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        open: (filePath, options) =>
          Deferred.succeed(attempted, undefined).pipe(Effect.andThen(fs.open(filePath, options))),
      });
      const fiber = yield* Effect.fork(
        Effect.flatMap(ResultsStore, (store) => store.prepare(path)).pipe(
          Effect.provide(ResultsStore.Default.pipe(Layer.provide(observedFs))),
        ),
      );
      yield* Deferred.await(attempted);
      yield* Effect.sleep("50 millis");
      const started = yield* Clock.currentTimeMillis;
      yield* Fiber.interrupt(fiber);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(500);
      expect(yield* fs.readFileString(`${path}.lock`)).toBe(owner);
    }).pipe(Effect.withClock(Clock.make())),
  ),
);
