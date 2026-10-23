import { dirname } from "node:path";
import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ResultsStore } from "./results-store";
import { withResultsStore } from "./testing";

/** A second, independent store whose filesystem differs in `overrides`, like another process. */
const otherStore = (fs: FileSystem.FileSystem, overrides: Partial<FileSystem.FileSystem>) =>
  ResultsStore.Default.pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, { ...fs, ...overrides })),
  );

describe("ResultsStore", () => {
  it.effect("reads a missing file as empty history", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const store = yield* ResultsStore;
        expect(yield* store.load(path)).toEqual({ runs: [] });
      }),
    ),
  );

  it.effect(
    "appends after every earlier run, repeated models included, without staging leftovers",
    () =>
      withResultsStore((path) =>
        Effect.gen(function* () {
          const store = yield* ResultsStore;
          const fs = yield* FileSystem.FileSystem;
          const runs = [
            makeRun({ modelSlug: "vendor/haiku" }),
            makeRun({ modelSlug: "vendor/sonnet" }),
            makeRun({ modelSlug: "vendor/haiku" }),
          ];
          yield* Effect.forEach(runs, (run) => store.append(path, run), { discard: true });
          expect((yield* store.load(path)).runs).toEqual(runs);
          expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
        }),
      ),
  );

  it.effect("rejects a duplicate run id and keeps the document", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const store = yield* ResultsStore;
        const run = makeRun();
        yield* store.append(path, run);
        expect((yield* Effect.flip(store.append(path, run)))._tag).toBe("ResultsStoreError");
        expect((yield* store.load(path)).runs).toEqual([run]);
      }),
    ),
  );

  it.effect("reports corrupt JSON and leaves it intact", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        yield* fs.writeFileString(path, "{broken");
        expect((yield* Effect.flip(store.append(path, makeRun())))._tag).toBe("ResultsStoreError");
        expect(yield* fs.readFileString(path)).toBe("{broken");
      }),
    ),
  );

  it.effect("refuses a history with a field the next save would drop", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        const contents = JSON.stringify({ runs: [{ ...makeRun(), note: "hand-added" }] });
        yield* fs.writeFileString(path, contents);
        expect((yield* Effect.flip(store.prepare(path)))._tag).toBe("ResultsStoreError");
        expect(yield* fs.readFileString(path)).toBe(contents);
      }),
    ),
  );

  it.effect("keeps the previous document and removes staging files when the rename fails", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        const original = makeRun();
        yield* store.append(path, original);
        const failure = yield* Effect.flip(
          Effect.flatMap(ResultsStore, (failing) => failing.append(path, makeRun())).pipe(
            Effect.provide(
              otherStore(fs, {
                rename: () =>
                  Effect.fail(
                    new PlatformError.SystemError({
                      module: "FileSystem",
                      method: "rename",
                      reason: "PermissionDenied",
                    }),
                  ),
              }),
            ),
          ),
        );
        expect(failure._tag).toBe("ResultsStoreError");
        expect((yield* store.load(path)).runs).toEqual([original]);
        expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
      }),
    ),
  );

  it.effect("prepares a missing output without creating a document or staging files", () =>
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

  it.effect("fails to prepare an output whose directory cannot be created", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        yield* fs.writeFileString(path, "a file, not a directory");
        const error = yield* Effect.flip(store.prepare(`${path}/results.json`));
        expect(error._tag).toBe("ResultsStoreError");
      }),
    ),
  );

  it.effect("removes its staging files when a writer is interrupted", () =>
    withResultsStore((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ResultsStore;
        const original = makeRun();
        yield* store.append(path, original);
        const reachedRename = yield* Deferred.make<void>();
        const fiber = yield* Effect.fork(
          Effect.flatMap(ResultsStore, (stalled) => stalled.append(path, makeRun())).pipe(
            Effect.provide(
              otherStore(fs, {
                rename: () =>
                  Deferred.succeed(reachedRename, undefined).pipe(Effect.andThen(Effect.never)),
              }),
            ),
          ),
        );
        yield* Deferred.await(reachedRename);
        yield* Fiber.interrupt(fiber);
        expect((yield* store.load(path)).runs).toEqual([original]);
        expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
      }),
    ),
  );
});
