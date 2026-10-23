// The results history file. It is checked before any paid request and then
// appended to one completed run at a time. Each write flushes a sibling temporary
// file and renames it over the document, under a lock file that every writing
// process honours.
import { dirname } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { type Results, ResultsJson, type Run, SCHEMA_VERSION } from "@probabench/domain";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ParseError } from "effect/ParseResult";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/** Another writer held the history lock for longer than LOCK_WAIT. */
export class HistoryLocked extends Data.TaggedError("HistoryLocked")<{
  readonly lockPath: string;
}> {
  override get message() {
    return `History is locked by another writer. Wait for it to finish. If no writer remains, remove the abandoned lock at ${this.lockPath} and retry.`;
  }
}

/** A read, write, decode or locking failure against the results file. */
export class ResultsStoreError extends Data.TaggedError("ResultsStoreError")<{
  readonly cause: PlatformError | ParseError | HistoryLocked;
}> {}

/** How long a writer waits for a busy history file, as the README states. */
const LOCK_WAIT = Schedule.spaced("25 millis").pipe(Schedule.upTo("5 seconds"));

const emptyResults: Results = { schemaVersion: SCHEMA_VERSION, runs: [] };
const decode = Schema.decode(ResultsJson);
const encode = Schema.encode(ResultsJson);
const toStoreError = (cause: PlatformError | ParseError | HistoryLocked) =>
  new ResultsStoreError({ cause });

export class ResultsStore extends Effect.Service<ResultsStore>()("ResultsStore", {
  effect: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    /** The document at `path`; a missing file reads as empty history. */
    const read = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.flatMap(decode),
        Effect.catchIf(
          (error) => error._tag === "SystemError" && error.reason === "NotFound",
          () => Effect.succeed(emptyResults),
        ),
      );

    /**
     * Runs `operation` while holding `<path>.lock`, which the CLI and the dev server's
     * runner both create exclusively. A lock left by a killed writer is never removed
     * here: once LOCK_WAIT runs out, HistoryLocked names the file for a human to delete.
     */
    const locked = <A>(path: string, operation: Effect.Effect<A, PlatformError | ParseError>) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        const lockPath = `${path}.lock`;
        return yield* Effect.acquireUseRelease(
          // Created in the uninterruptible acquire, so release always owns the file.
          fs.open(lockPath, { flag: "wx" }).pipe(
            Effect.scoped,
            Effect.asVoid,
            Effect.catchIf(
              (error) => error._tag === "SystemError" && error.reason === "AlreadyExists",
              () => Effect.fail(new HistoryLocked({ lockPath })),
            ),
          ),
          // The pid is for a human inspecting an abandoned lock.
          () =>
            fs
              .writeFileString(lockPath, JSON.stringify({ pid: process.pid }))
              .pipe(Effect.andThen(operation)),
          () => Effect.orDie(fs.remove(lockPath)),
        ).pipe(
          // Wait outside the uninterruptible acquire, so a waiting writer cancels at once.
          Effect.retry({ while: (error) => error._tag === "HistoryLocked", schedule: LOCK_WAIT }),
        );
      });

    /** Flushes a sibling temporary file, then renames it over the document. */
    const write = (path: string, results: Results) =>
      Effect.gen(function* () {
        const contents = yield* encode(results);
        const temporary = yield* fs.makeTempFileScoped({
          directory: dirname(path),
          prefix: ".probabench-",
        });
        yield* Effect.scoped(
          Effect.flatMap(fs.open(temporary, { flag: "w" }), (file) =>
            file.writeAll(new TextEncoder().encode(contents)).pipe(Effect.andThen(file.sync)),
          ),
        );
        yield* fs.rename(temporary, path);
      }).pipe(Effect.scoped);

    const load = (path: string): Effect.Effect<Results, ResultsStoreError> =>
      read(path).pipe(Effect.mapError(toStoreError));

    /** Fails before any paid request on corrupt history, an unusable directory or a stuck lock. */
    const prepare = (path: string): Effect.Effect<void, ResultsStoreError> =>
      locked(path, read(path)).pipe(Effect.asVoid, Effect.mapError(toStoreError));

    /** Adds `run` after every earlier run, including the same model's. */
    const append = (path: string, run: Run): Effect.Effect<void, ResultsStoreError> =>
      locked(
        path,
        Effect.flatMap(read(path), (results) =>
          write(path, { ...results, runs: [...results.runs, run] }),
        ),
      ).pipe(Effect.mapError(toStoreError));

    return { load, prepare, append };
  }),
}) {}
