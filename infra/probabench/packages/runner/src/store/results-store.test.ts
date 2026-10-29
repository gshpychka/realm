import { dirname } from "node:path";
import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { appendRun, prepareHistory } from "./results-store";
import { readResults, withHistoryFile } from "./testing";

/** Runs an effect against `fs` with `overrides` swapped in, such as a failing rename. */
const withFileSystem = (fs: FileSystem.FileSystem, overrides: Partial<FileSystem.FileSystem>) =>
  Effect.provideService(FileSystem.FileSystem, { ...fs, ...overrides });

describe("appendRun", () => {
  it.effect("retains every model when many saves finish together", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const runs = Array.from({ length: 20 }, (_, i) =>
          makeRun({ modelSlug: `vendor/model-${i}` }),
        );
        yield* Effect.forEach(runs, (run) => appendRun(path, run), {
          concurrency: "unbounded",
          discard: true,
        });
        const saved = (yield* readResults(path)).runs;
        expect(saved).toHaveLength(runs.length);
        expect(saved.map((run) => run.id).sort()).toEqual(runs.map((run) => run.id).sort());
      }),
    ),
  );

  it.effect("reports corrupt JSON and leaves it intact", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "{broken");
        yield* Effect.flip(appendRun(path, makeRun()));
        expect(yield* fs.readFileString(path)).toBe("{broken");
      }),
    ),
  );

  it.effect("keeps the previous document and removes staging files when the rename fails", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const original = makeRun();
        yield* appendRun(path, original);
        yield* Effect.flip(
          appendRun(path, makeRun()).pipe(
            withFileSystem(fs, {
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
        );
        expect((yield* readResults(path)).runs).toEqual([original]);
        expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
      }),
    ),
  );

  it.effect("removes its staging files when a writer is interrupted", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const original = makeRun();
        yield* appendRun(path, original);
        const reachedRename = yield* Deferred.make<void>();
        const fiber = yield* Effect.fork(
          appendRun(path, makeRun()).pipe(
            withFileSystem(fs, {
              rename: () =>
                Deferred.succeed(reachedRename, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        );
        yield* Deferred.await(reachedRename);
        yield* Fiber.interrupt(fiber);
        expect((yield* readResults(path)).runs).toEqual([original]);
        expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
      }),
    ),
  );
});

describe("prepareHistory", () => {
  it.effect("refuses a history with a field the next save would drop", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const contents = JSON.stringify({ runs: [{ ...makeRun(), note: "hand-added" }] });
        yield* fs.writeFileString(path, contents);
        yield* Effect.flip(prepareHistory(path));
        expect(yield* fs.readFileString(path)).toBe(contents);
      }),
    ),
  );
});
