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
  it.effect(
    "appends after every earlier run, repeated models included, without staging leftovers",
    () =>
      withHistoryFile((path) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runs = [
            makeRun({ modelSlug: "vendor/haiku" }),
            makeRun({ modelSlug: "vendor/sonnet" }),
            makeRun({ modelSlug: "vendor/haiku" }),
          ];
          yield* Effect.forEach(runs, (run) => appendRun(path, run), { discard: true });
          expect((yield* readResults(path)).runs).toEqual(runs);
          expect(yield* fs.readDirectory(dirname(path))).toEqual(["results.json"]);
        }),
      ),
  );

  it.effect("rejects a duplicate run id and keeps the document", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const run = makeRun();
        yield* appendRun(path, run);
        expect((yield* Effect.flip(appendRun(path, run)))._tag).toBe("ParseError");
        expect((yield* readResults(path)).runs).toEqual([run]);
      }),
    ),
  );

  it.effect("reports corrupt JSON and leaves it intact", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "{broken");
        expect((yield* Effect.flip(appendRun(path, makeRun())))._tag).toBe("ParseError");
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
        const failure = yield* Effect.flip(
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
        expect(failure._tag).toBe("SystemError");
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
  it.effect("prepares a missing history without creating a document or staging files", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* prepareHistory(path);
        expect(yield* fs.exists(path)).toBe(false);
        expect(yield* fs.readDirectory(dirname(path))).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a history with a field the next save would drop", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const contents = JSON.stringify({ runs: [{ ...makeRun(), note: "hand-added" }] });
        yield* fs.writeFileString(path, contents);
        expect((yield* Effect.flip(prepareHistory(path)))._tag).toBe("ParseError");
        expect(yield* fs.readFileString(path)).toBe(contents);
      }),
    ),
  );

  it.effect("fails on a history whose directory cannot be created", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(path, "a file, not a directory");
        const error = yield* Effect.flip(prepareHistory(`${path}/results.json`));
        expect(error._tag).toBe("SystemError");
      }),
    ),
  );
});
