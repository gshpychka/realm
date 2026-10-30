import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as FileSystem from "@effect/platform/FileSystem";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PRESET,
  MODEL_ALIASES,
  ModelSlug,
  ReasoningMode,
  StepPercent,
  TrialsPerStep,
} from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { InvalidOptions, type SamplingOptions } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { DEFAULT_MAX_TOKENS } from "../sampling/request";

export const DEFAULT_OPTIONS: SamplingOptions = {
  trialsPerStep: DEFAULT_PRESET.trialsPerStep,
  stepPercent: DEFAULT_PRESET.stepPercent,
  concurrency: DEFAULT_CONCURRENCY,
  maxTokens: DEFAULT_MAX_TOKENS,
};

const PositiveInt = Schema.Int.pipe(Schema.positive());
const Configuration = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: ModelSlug,
      selected: Schema.Boolean,
      reasoning: ReasoningMode,
      trials: TrialsPerStep,
      step: StepPercent,
    }),
  ),
  concurrency: PositiveInt,
  maxTokens: PositiveInt,
}).pipe(
  Schema.filter(
    (config) =>
      config.models.some((model) => model.selected) &&
      new Set(config.models.map((model) => model.slug)).size === config.models.length,
  ),
);
export type Configuration = typeof Configuration.Type;
const ConfigurationFile = Schema.parseJson(Configuration, { space: 2 });
export const CONFIGURATION_PATH = fileURLToPath(
  new URL("../../../../.data/config.json", import.meta.url),
);

export interface SetupOverrides {
  readonly models?: readonly ModelSeries[] | undefined;
  readonly reasoning?: ReasoningMode | undefined;
  readonly trials?: number | undefined;
  readonly step?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export const defaultConfiguration = (): Configuration => ({
  models: MODEL_ALIASES.map((model) => ({
    slug: model.slug,
    selected: true,
    reasoning: model.reasoning,
    trials: DEFAULT_OPTIONS.trialsPerStep,
    step: DEFAULT_OPTIONS.stepPercent,
  })),
  concurrency: DEFAULT_OPTIONS.concurrency,
  maxTokens: DEFAULT_OPTIONS.maxTokens,
});

/** Explicit flags override saved selections and values. */
export const initialConfiguration = (
  saved: Configuration | null,
  overrides: SetupOverrides = {},
): Configuration => {
  const defaults = defaultConfiguration();
  const models = new Map(
    defaults.models.map((model) => [model.slug, { ...model, selected: saved === null }]),
  );
  for (const model of saved?.models ?? []) models.set(model.slug, { ...model });
  if (overrides.models) {
    for (const model of models.values()) model.selected = false;
    for (const series of overrides.models) {
      const model = models.get(series.modelSlug) ?? {
        slug: series.modelSlug,
        trials: DEFAULT_OPTIONS.trialsPerStep,
        step: DEFAULT_OPTIONS.stepPercent,
      };
      models.set(series.modelSlug, { ...model, selected: true, reasoning: series.reasoning });
    }
  }
  for (const model of models.values()) {
    if (!model.selected) continue;
    if (overrides.reasoning !== undefined) model.reasoning = overrides.reasoning;
    if (overrides.trials !== undefined) model.trials = overrides.trials;
    if (overrides.step !== undefined) model.step = overrides.step;
  }
  return {
    models: [...models.values()],
    concurrency: overrides.concurrency ?? saved?.concurrency ?? defaults.concurrency,
    maxTokens: overrides.maxTokens ?? saved?.maxTokens ?? defaults.maxTokens,
  };
};

export const loadConfiguration = (path = CONFIGURATION_PATH) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fs
      .readFileString(path)
      .pipe(Effect.flatMap(Schema.decode(ConfigurationFile)));
    return { config, warning: null };
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        config: null,
        warning:
          error._tag === "SystemError" && error.reason === "NotFound"
            ? null
            : "Saved settings could not be read; using defaults.",
      }),
    ),
  );

/** Replace the saved configuration only after the complete document is written. */
export const saveConfiguration = (config: Configuration, path = CONFIGURATION_PATH) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* Schema.encode(ConfigurationFile)(config);
      yield* fs.makeDirectory(dirname(path), { recursive: true });
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: dirname(path),
        prefix: ".config-",
      });
      const temporary = join(directory, "config.json");
      yield* fs.writeFileString(temporary, text);
      yield* fs.rename(temporary, path);
    }),
  ).pipe(
    Effect.mapError(
      () =>
        new InvalidOptions({
          message: `Could not save settings to ${path}. Check that the directory is writable.`,
        }),
    ),
  );
