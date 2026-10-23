// Test fixtures for suites that read and write a history file. Never import this
// from application code.
import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import { ResultsStore } from "./results-store";

/** A ResultsStore over a fresh temporary directory, so writes exercise the real filesystem. */
export const withResultsStore = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R | ResultsStore | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "probabench-test-" });
    return yield* use(join(directory, "results.json")).pipe(Effect.provide(ResultsStore.Default));
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));
