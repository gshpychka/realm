import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import * as Effect from "effect/Effect";
import { appendCheckpoints } from "./results-store";
import { readResults, withHistoryFile } from "./testing";

/** Runs an effect against `fs` with `overrides` swapped in, such as a failing rename. */
const withFileSystem = (fs: FileSystem.FileSystem, overrides: Partial<FileSystem.FileSystem>) =>
  Effect.provideService(FileSystem.FileSystem, { ...fs, ...overrides });

describe("appendCheckpoints", () => {
  it.effect("keeps the previous document when saving fails", () =>
    withHistoryFile((path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const original = makeRun();
        yield* appendCheckpoints(path, [original]);
        yield* Effect.flip(
          appendCheckpoints(path, [makeRun()]).pipe(
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
      }),
    ),
  );
});
