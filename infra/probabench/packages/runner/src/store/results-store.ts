// Append immutable checkpoints, publishing each batch through an atomic snapshot.
// Concurrent replies share a durable local write and a Cloudflare upload.
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import {
  type Outcome,
  type Probability,
  RESULTS_FILE,
  Results,
  type Run,
} from "@probabench/domain";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ParseError } from "effect/ParseResult";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as lockfile from "proper-lockfile";
import type { SamplingOptions } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { CloudHistory, CloudHistoryError } from "./cloud-history";

/** Resolve from the source file so CLI and dev server share history in any cwd. */
export const HISTORY_PATH = fileURLToPath(
  new URL(`../../../../.data/${RESULTS_FILE}`, import.meta.url),
);

export type HistoryError = PlatformError | ParseError | CloudHistoryError;

export class HistoryLockError extends Data.TaggedError("HistoryLockError")<{
  readonly message: string;
  readonly busy: boolean;
  readonly cause: unknown;
}> {}

const emptyResults: Results = { runs: [] };
/** Results as pretty-printed JSON: the history file's format. */
const ResultsFile = Schema.parseJson(Results, { space: 2 });
// Strict decoding protects additional fields from being dropped during a rewrite.
const decode = Schema.decode(ResultsFile, { onExcessProperty: "error" });
const encode = Schema.encode(ResultsFile);
// A checkpoint's read/modify/rename must finish before another writer reads.
const writer = Effect.unsafeMakeSemaphore(1);

/** The document at `path`; a missing file reads as empty history. */
const read = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.flatMap(decode),
    Effect.catchIf(
      (error) => error._tag === "SystemError" && error.reason === "NotFound",
      () => Effect.succeed(emptyResults),
    ),
  );

/** Read the local recovery file for planning and synchronization. */
export const readHistory = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => read(fs, path));

/** Hold the lease from daily planning through the final checkpoint, including cancellation. */
export const withHistoryLock = <A, E, R>(path: string, operation: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    let announced = false;
    const attempt = Effect.tryPromise({
      try: () => lockfile.lock(path, { realpath: false, stale: 30_000, update: 10_000 }),
      catch: (cause) =>
        new HistoryLockError({
          message: cause instanceof Error ? cause.message : "Could not lock benchmark history",
          busy:
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ELOCKED",
          cause,
        }),
    });
    const acquire = (): Effect.Effect<void, HistoryLockError, Scope.Scope> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.acquireRelease(attempt, (release) => Effect.promise(release)).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (error) => error.busy,
            () =>
              Effect.gen(function* () {
                if (!announced) {
                  announced = true;
                  yield* Console.log("Waiting for another benchmark to finish…");
                }
                yield* restore(Effect.sleep("250 millis"));
                yield* restore(Effect.suspend(acquire));
              }),
          ),
        ),
      );
    yield* acquire();
    return yield* operation;
  }).pipe(Effect.scoped);

/** A file in a temporary `.probabench-*` directory beside the history, removed with its scope. */
const stage = (fs: FileSystem.FileSystem, path: string) =>
  fs.makeTempFileScoped({ directory: dirname(path), prefix: ".probabench-" });

/**
 * Flushes the document to a staged file beside it, then renames that file over it,
 * so a reader never sees a partial write.
 */
const write = (fs: FileSystem.FileSystem, path: string, results: Results) =>
  Effect.gen(function* () {
    const contents = yield* encode(results);
    const temporary = yield* stage(fs, path);
    yield* Effect.scoped(
      Effect.flatMap(fs.open(temporary, { flag: "w" }), (file) =>
        file.writeAll(new TextEncoder().encode(contents)).pipe(Effect.andThen(file.sync)),
      ),
    );
    yield* fs.rename(temporary, path);
  }).pipe(Effect.scoped);

/** Fails before any paid request on corrupt history or a directory a save cannot write. */
export const prepareHistory = (
  path: string,
): Effect.Effect<Results, PlatformError | ParseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    const history = yield* read(fs, path);
    // An existing directory may still be read-only: stage a file now, as a save will.
    yield* Effect.scoped(stage(fs, path));
    return history;
  });

/** Append immutable observations to the local recovery file. */
export const appendCheckpoints = (
  path: string,
  checkpoints: readonly Run[],
): Effect.Effect<void, PlatformError | ParseError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.flatMap(read(fs, path), (results) =>
      write(fs, path, { ...results, runs: [...results.runs, ...checkpoints] }),
    ),
  ).pipe(writer.withPermits(1));

/** Merge immutable records by ID, rejecting conflicting contents. */
export const mergeHistory = (local: Results, cloud: Results): Results => {
  const runs = new Map(local.runs.map((run) => [run.id, run]));
  for (const run of cloud.runs) {
    const previous = runs.get(run.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(run))
      throw new CloudHistoryError({ message: `Conflicting benchmark checkpoint: ${run.id}` });
    runs.set(run.id, run);
  }
  return { runs: [...runs.values()] };
};

/** Planning consults the shared history, including unuploaded local recovery records. */
export const readSharedHistory = (path: string) =>
  Effect.gen(function* () {
    const cloud = yield* CloudHistory;
    const local = yield* readHistory(path);
    const remote = yield* cloud.read;
    return yield* Effect.try({
      try: () => mergeHistory(local, remote),
      catch: (error) => error as CloudHistoryError,
    });
  });

/** Synchronize the recovery copy before sampling. */
export const synchronizeHistory = (
  path: string,
  append: (runs: readonly Run[]) => Effect.Effect<void, CloudHistoryError>,
) =>
  Effect.gen(function* () {
    const cloud = yield* CloudHistory;
    const local = yield* prepareHistory(path);
    const remote = yield* cloud.read;
    yield* Effect.try({
      try: () => mergeHistory(local, remote),
      catch: (error) => error as CloudHistoryError,
    });
    const known = new Set(remote.runs.map((run) => run.id));
    yield* append(local.runs.filter((run) => !known.has(run.id)));
    const cached = new Set(local.runs.map((run) => run.id));
    const missing = remote.runs.filter((run) => !cached.has(run.id));
    if (missing.length > 0) yield* appendCheckpoints(path, missing);
    return yield* readHistory(path);
  });

/** Hold the local file lease while synchronizing and collecting results. */
export const withSharedHistory = <A, E, R>(
  path: string,
  use: (
    history: Results,
    upload: (runs: readonly Run[]) => Effect.Effect<void, CloudHistoryError>,
  ) => Effect.Effect<A, E, R>,
) =>
  withHistoryLock(
    path,
    Effect.gen(function* () {
      const cloud = yield* CloudHistory;
      const history = yield* synchronizeHistory(path, cloud.append);
      return yield* use(history, cloud.append);
    }),
  );

/**
 * Saving a reply is uninterruptible. Concurrent replies share a local write and upload.
 */
export const makeCheckpointer = (
  path: string,
  options:
    | Pick<SamplingOptions, "trialsPerStep" | "stepPercent">
    | ((series: ModelSeries) => Pick<SamplingOptions, "trialsPerStep" | "stepPercent">),
  startedAt: string,
  upload: (runs: readonly Run[]) => Effect.Effect<void, CloudHistoryError> = () => Effect.void,
) => {
  interface Pending {
    readonly series: ModelSeries;
    readonly x: Probability;
    readonly outcome: Outcome;
    readonly done: Deferred.Deferred<void, HistoryError>;
  }
  const pending: Pending[] = [];
  const flush = Effect.unsafeMakeSemaphore(1);
  let failure: Exit.Exit<void, HistoryError> | undefined;

  return (series: ModelSeries, x: Probability, outcome: Outcome) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const done = yield* Deferred.make<void, HistoryError>();
        pending.push({ series, x, outcome, done });
        yield* flush.withPermits(1)(
          Effect.gen(function* () {
            if (yield* Deferred.isDone(done)) return;
            const batch = pending.splice(0);
            const models = new Map<
              string,
              { series: ModelSeries; targets: Map<Probability, Outcome[]> }
            >();
            for (const sample of batch) {
              let model = models.get(sample.series.model);
              if (!model) {
                model = { series: sample.series, targets: new Map() };
                models.set(sample.series.model, model);
              }
              const outcomes = model.targets.get(sample.x) ?? [];
              outcomes.push(sample.outcome);
              model.targets.set(sample.x, outcomes);
            }
            const checkpoints: Run[] = [...models.values()].map(({ series, targets }) => {
              const sampling = typeof options === "function" ? options(series) : options;
              return {
                id: randomUUID(),
                ...series,
                trialsPerStep: sampling.trialsPerStep,
                stepPercent: sampling.stepPercent,
                startedAt,
                points: [...targets]
                  .sort(([a], [b]) => a - b)
                  .map(([x, outcomes]) => ({ x, outcomes })),
              };
            });
            const result = yield* Effect.exit(
              appendCheckpoints(path, checkpoints).pipe(
                Effect.andThen(failure ?? upload(checkpoints)),
              ),
            );
            if (Exit.isFailure(result)) failure = result;
            for (const sample of batch) yield* Deferred.done(sample.done, result);
          }),
        );
        yield* Deferred.await(done);
      }),
    );
};
