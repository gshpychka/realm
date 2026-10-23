// ResultsStore persists the shared Results document via @effect/platform's
// FileSystem. Every completed sweep appends its independent execution id,
// retaining previous experiments for the same model.
// Writes flush a sibling temporary file before atomically replacing the document.

import { dirname, join } from "node:path";
import { type PlatformError, SystemError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { type Results, ResultsJson, type Run, SCHEMA_VERSION } from "@probabench/domain";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ParseError } from "effect/ParseResult";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** A read, write, or decode failure against the results file. */
export class ResultsStoreError extends Data.TaggedError("ResultsStoreError")<{
  readonly cause: PlatformError | ParseError;
}> {}

/** The document a missing file reads as. */
const emptyResults: Results = { schemaVersion: SCHEMA_VERSION, runs: [] };

/** Every sweep is an independent experiment, including repeated models. */
export const appendRun = (results: Results, run: Run): Results => ({
  schemaVersion: SCHEMA_VERSION,
  runs: [...results.runs, run],
});

const decode = Schema.decode(ResultsJson);
const encode = Schema.encode(ResultsJson);

/** Reads history and atomically persists completed experiments. */
export class ResultsStore extends Effect.Service<ResultsStore>()("ResultsStore", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const writes = yield* Effect.makeSemaphore(1);

    /** Reads and decodes the document at `path`; a missing file yields an empty Results. */
    const load = (path: string): Effect.Effect<Results, ResultsStoreError> =>
      Effect.gen(function* () {
        const contents = yield* fs.readFileString(path).pipe(
          Effect.catchIf(
            (error) => error._tag === "SystemError" && error.reason === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );
        return contents === undefined ? emptyResults : yield* decode(contents);
      }).pipe(Effect.mapError((cause) => new ResultsStoreError({ cause })));

    /**
     * Exclusive filesystem creation coordinates independent CLI/browser processes.
     * Lock only the short transaction. Never unlink someone else's lock: a crashed
     * writer leaves an actionable Busy error until its abandoned lock is removed.
     */
    const locked = <A, R>(
      path: string,
      operation: Effect.Effect<A, ResultsStoreError, R>,
    ): Effect.Effect<A, ResultsStoreError, R> =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        const lockPath = `${path}.lock`;
        const acquire = fs.open(lockPath, { flag: "wx" }).pipe(
          Effect.asVoid,
          Effect.scoped,
          Effect.mapError((error) =>
            error._tag === "SystemError" && error.reason === "AlreadyExists"
              ? { _tag: "HistoryLockContention" as const }
              : error,
          ),
        );
        return yield* Effect.acquireUseRelease(
          acquire,
          () =>
            fs
              .writeFileString(
                lockPath,
                JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
              )
              .pipe(Effect.andThen(operation)),
          () => fs.remove(lockPath).pipe(Effect.orDie),
        ).pipe(
          // Wait outside acquireUseRelease's protected acquisition so a contending
          // browser/CLI process can cancel immediately without owning any lock.
          Effect.retry({
            while: (error) => error._tag === "HistoryLockContention",
            schedule: Schedule.spaced("25 millis").pipe(Schedule.intersect(Schedule.recurs(200))),
          }),
          Effect.mapError((error) =>
            error._tag === "HistoryLockContention"
              ? new SystemError({
                  module: "FileSystem",
                  method: "acquireHistoryLock",
                  reason: "Busy",
                  pathOrDescriptor: lockPath,
                  description: `History is locked by another writer. Wait for it to finish. If no writer remains, remove the abandoned lock at ${lockPath} and retry.`,
                })
              : error,
          ),
        );
      }).pipe(
        writes.withPermits(1),
        Effect.mapError((cause) =>
          cause instanceof ResultsStoreError ? cause : new ResultsStoreError({ cause }),
        ),
      );

    /** Detect corrupt history, unusable output directories, and abandoned locks before paid calls. */
    const prepare = (path: string): Effect.Effect<void, ResultsStoreError> =>
      locked(path, load(path).pipe(Effect.asVoid));

    /** Flush a sibling temporary file before atomically replacing the visible document. */
    const write = (path: string, results: Results): Effect.Effect<void, ResultsStoreError> =>
      Effect.gen(function* () {
        const contents = yield* encode(results);
        const directory = dirname(path);
        yield* fs.makeDirectory(directory, { recursive: true });
        const temporary = join(
          yield* fs.makeTempDirectoryScoped({ directory, prefix: ".probabench-" }),
          "results.json",
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(temporary, { flag: "wx" });
            yield* file.writeAll(new TextEncoder().encode(contents));
            yield* file.sync;
          }),
        );
        yield* fs.rename(temporary, path);
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) => new ResultsStoreError({ cause })),
      );

    const save = (path: string, results: Results): Effect.Effect<void, ResultsStoreError> =>
      locked(path, write(path, results));

    /** Read-modify-write: append `run` without replacing any previous execution. */
    const append = (path: string, run: Run): Effect.Effect<Results, ResultsStoreError> =>
      locked(
        path,
        Effect.gen(function* () {
          const results = appendRun(yield* load(path), run);
          yield* write(path, results);
          return results;
        }),
      );

    return { load, prepare, save, append } as const;
  }),
}) {}
