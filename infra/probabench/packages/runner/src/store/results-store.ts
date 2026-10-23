// The results history file: checked before any paid request, then appended to one
// completed run at a time. Saves replace the file atomically but are not serialized
// across processes: two benchmarks saving in the same instant can drop one run, so
// run one benchmark at a time.
import { dirname } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import { Results, type Run } from "@probabench/domain";
import * as Effect from "effect/Effect";
import type { ParseError } from "effect/ParseResult";
import * as Schema from "effect/Schema";

const emptyResults: Results = { runs: [] };
/** Results as pretty-printed JSON: the history file's format. */
const ResultsFile = Schema.parseJson(Results, { space: 2 });
// Strict, because every save rewrites the whole file: a key the schema does not know
// would be dropped from the only copy of the history.
const decode = Schema.decode(ResultsFile, { onExcessProperty: "error" });
const encode = Schema.encode(ResultsFile);

/** The document at `path`; a missing file reads as empty history. */
const read = (fs: FileSystem.FileSystem, path: string) =>
  fs.readFileString(path).pipe(
    Effect.flatMap(decode),
    Effect.catchIf(
      (error) => error._tag === "SystemError" && error.reason === "NotFound",
      () => Effect.succeed(emptyResults),
    ),
  );

/**
 * Flushes the document to a file in a temporary `.probabench-*` directory beside it,
 * then renames that file over it, so a reader never sees a partial write.
 */
const write = (fs: FileSystem.FileSystem, path: string, results: Results) =>
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

/** Fails before any paid request on corrupt history or an unusable directory. */
export const prepareHistory = (
  path: string,
): Effect.Effect<void, PlatformError | ParseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* read(fs, path);
  });

/** Adds `run` after every earlier run, including the same model's. */
export const appendRun = (
  path: string,
  run: Run,
): Effect.Effect<void, PlatformError | ParseError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.flatMap(read(fs, path), (results) =>
      write(fs, path, { ...results, runs: [...results.runs, run] }),
    ),
  );
