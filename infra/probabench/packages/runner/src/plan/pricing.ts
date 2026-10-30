import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Catalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, pricing: Schema.Unknown })).pipe(
    Schema.minItems(1),
  ),
});
const CachedCatalog = Schema.Struct({
  fetchedAt: Schema.String.pipe(Schema.filter((date) => Number.isFinite(Date.parse(date)))),
  data: Catalog.fields.data,
});

export interface Prices {
  readonly fetchedAt: string | null;
  readonly data: typeof Catalog.Type.data;
  readonly warning: string | null;
}

export const PRICES_PATH = fileURLToPath(new URL("../../../../.data/prices.json", import.meta.url));

/** A saved quote is reused until the user explicitly refreshes prices. */
export const loadPrices = ({ path = PRICES_PATH, refresh = false } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cached = yield* fs
      .readFileString(path)
      .pipe(Effect.flatMap(Schema.decode(Schema.parseJson(CachedCatalog))), Effect.option);
    if (!refresh && Option.isSome(cached))
      return { ...cached.value, warning: null } satisfies Prices;

    const catalog = yield* HttpClient.get("https://openrouter.ai/api/v1/models").pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Catalog)),
      Effect.timeout("8 seconds"),
      Effect.option,
    );
    if (Option.isNone(catalog))
      return {
        ...(Option.isSome(cached) ? cached.value : { fetchedAt: null, data: [] }),
        warning: Option.isSome(cached)
          ? "Price refresh failed; using saved prices."
          : "Could not fetch OpenRouter prices.",
      } satisfies Prices;

    const snapshot = {
      fetchedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      data: catalog.value.data,
    };
    const saved = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(path), { recursive: true });
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: dirname(path),
          prefix: ".prices-",
        });
        const temporary = join(directory, "prices.json");
        yield* fs.writeFileString(temporary, JSON.stringify(snapshot));
        yield* fs.rename(temporary, path);
      }),
    ).pipe(Effect.option);
    return {
      ...snapshot,
      warning: Option.isNone(saved)
        ? "Prices loaded, but the local cache could not be saved."
        : null,
    } satisfies Prices;
  });
