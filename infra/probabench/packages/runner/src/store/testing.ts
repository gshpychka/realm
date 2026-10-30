// Test fixtures for suites that read and write a history file. Never import this
// from application code.
import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Results } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CloudHistory } from "./cloud-history";

/** A history path in a fresh temporary directory, so writes exercise the real filesystem. */
export const withHistoryFile = <A, E, R>(
  use: (path: string) => Effect.Effect<A, E, R | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "probabench-test-" });
    return yield* use(join(directory, "results.json"));
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeFileSystem.layer),
    Effect.provideService(CloudHistory, {
      read: Effect.succeed({ runs: [] }),
      page: (after) => Effect.succeed({ runs: [], cursor: after, next: null }),
      checkWrite: Effect.void,
      append: () => Effect.void,
    }),
  );

/** The decoded history at `path`, for assertions. */
export const readResults = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.flatMap(Schema.decode(Schema.parseJson(Results))),
  );
