// Pure shaping of measured bit frequencies into chart rows and accessible table data.
import {
  measurePoint,
  type PointMeasurement,
  type Results,
  summarizeRun,
} from "@probabench/domain";

export const MODEL_COLORS = [
  "#d8a657",
  "#7daea3",
  "#d3869b",
  "#a9b665",
  "#ea6962",
  "#b4a7d6",
  "#e78a4e",
  "#89b482",
] as const;

export const REFERENCE_KEY = "reference";
export const REFERENCE_LABEL = "Calibrated frequency (y = x)";
export const REFERENCE_COLOR = "#928374";

/** Append-only notebook order keeps existing colours stable and avoids collisions within the palette. */
export const modelColors = (
  runs: ReadonlyArray<{ readonly model: string }>,
): ReadonlyMap<string, string> => {
  const colors = new Map<string, string>();
  for (const run of runs) {
    if (!colors.has(run.model))
      colors.set(run.model, MODEL_COLORS[colors.size % MODEL_COLORS.length] ?? MODEL_COLORS[0]);
  }
  return colors;
};

/** Reused colours gain a distinct stroke after the palette is exhausted. */
export const modelDash = (
  model: string,
  colors: ReadonlyMap<string, string>,
): string | undefined => {
  const index = [...colors.keys()].indexOf(model);
  return [undefined, "8 4", "2 4", "8 3 2 3"][
    Math.floor(Math.max(0, index) / MODEL_COLORS.length) % 4
  ];
};

export interface Series {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly startedAt: string;
  readonly valid: number;
  readonly total: number;
}

export type ChartRow = { readonly x: number; readonly reference: number } & Record<
  string,
  number | null | readonly [number, number]
>;

export interface ChartModel {
  readonly series: ReadonlyArray<Series>;
  readonly rows: ReadonlyArray<ChartRow>;
  /** Each line uses its own sampled grid; another model's extra targets cannot create false gaps. */
  readonly seriesRows: ReadonlyMap<string, ReadonlyArray<ChartRow>>;
  readonly meta: ReadonlyMap<number, ReadonlyMap<string, PointMeasurement>>;
}

/** Opaque series keys prevent model ids such as "x", "reference" or "a.b" colliding with chart paths. */
export const buildChartModel = (
  results: Results,
  colors?: ReadonlyMap<string, string>,
): ChartModel => {
  const palette = colors ?? modelColors(results.runs);
  const series = results.runs.map((run, index): Series => {
    const { valid, total } = summarizeRun(run);
    return {
      id: run.id,
      key: `series_${index}`,
      label: run.model,
      color: palette.get(run.model) ?? MODEL_COLORS[0],
      startedAt: run.startedAt,
      valid,
      total,
    };
  });
  const pointsByRun = results.runs.map(
    (run) => new Map(run.points.map((point) => [point.x as number, point])),
  );
  // Endpoints keep the identity reference visible even for a partial/empty sweep.
  const xs = [
    ...new Set([
      0,
      1,
      ...results.runs.flatMap((run) => run.points.map((point) => point.x as number)),
    ]),
  ].sort((a, b) => a - b);
  const meta = new Map<number, ReadonlyMap<string, PointMeasurement>>();
  const rows = xs.map((x): ChartRow => {
    const row: ChartRow = { x, [REFERENCE_KEY]: x };
    const metaAtX = new Map<string, PointMeasurement>();
    for (const [index, item] of series.entries()) {
      const point = pointsByRun[index]?.get(x);
      if (!point) {
        row[item.key] = null;
        continue;
      }
      const measured = measurePoint(point);
      const { observed, interval } = measured;
      row[item.key] = observed;
      row[`${item.key}_interval`] =
        observed !== null && interval !== null
          ? [observed - interval[0], interval[1] - observed]
          : null;
      metaAtX.set(item.key, measured);
    }
    meta.set(x, metaAtX);
    return row;
  });
  const seriesRows = new Map(
    series.map((item) => [item.key, rows.filter((row) => meta.get(row.x)?.has(item.key))]),
  );
  return { series, rows, seriesRows, meta };
};
