import { type Run, type RunSummary, summarizeRun } from "@probabench/domain";
import { type ModelStyle, styleOf } from "../common/palette";

/** A lone run still gets a visible minute either side. */
const MIN_PADDING_MS = 60_000;
/** Y gridlines every 5 pp (1 / 20). */
const SCORE_STEPS = 20;
const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

export interface HistoryPoint {
  readonly timestamp: number;
  /** The plotted y value: summary.meanCalibrationError. */
  readonly score: number | null;
  readonly run: Run;
  readonly summary: RunSummary;
}

export interface HistorySeries {
  readonly model: string;
  readonly style: ModelStyle;
  readonly points: HistoryPoint[];
}

export interface HistoryChartModel {
  readonly points: readonly HistoryPoint[];
  readonly series: readonly HistorySeries[];
  readonly domain: [number, number];
  readonly upperScore: number;
  readonly tickFormat: Intl.DateTimeFormat;
}

/** Axis ticks name the hour within a day, the day within a year, and the year beyond. */
const timeTickFormat = (span: number): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(
    "en-US",
    span < DAY_MS
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }
      : {
          month: "short",
          day: "numeric",
          ...(span >= YEAR_MS ? { year: "2-digit" as const } : {}),
          timeZone: "UTC",
        },
  );

/** Each model owns its timeline. Null scores break lines; timestamp ties retain archive order. */
export const buildHistoryChartModel = (
  runs: readonly Run[],
  styles: ReadonlyMap<string, ModelStyle>,
): HistoryChartModel => {
  const points = runs
    .map((run): HistoryPoint => {
      const summary = summarizeRun(run);
      return {
        timestamp: Date.parse(run.startedAt),
        score: summary.meanCalibrationError,
        run,
        summary,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  const series = new Map<string, HistorySeries>();
  for (const point of points) {
    const { model } = point.run;
    const line = series.get(model);
    if (line) line.points.push(point);
    else series.set(model, { model, style: styleOf(styles, model), points: [point] });
  }
  // An empty history draws an empty axis around now.
  const minimum = points[0]?.timestamp ?? Date.now();
  const maximum = points.at(-1)?.timestamp ?? minimum;
  const padding = Math.max(MIN_PADDING_MS, (maximum - minimum) * 0.05);
  const worst = points.reduce((max, point) => Math.max(max, point.score ?? 0), 0);
  return {
    points,
    series: [...series.values()],
    domain: [minimum - padding, maximum + padding],
    // The worst gap rounded up to a gridline, plus one gridline of headroom, capped at 100 pp.
    upperScore: Math.min(1, (Math.ceil(worst * SCORE_STEPS) + 1) / SCORE_STEPS),
    tickFormat: timeTickFormat(maximum - minimum),
  };
};
