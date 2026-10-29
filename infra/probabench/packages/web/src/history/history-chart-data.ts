import type { EvidenceCheckpoint } from "@probabench/domain";
import { type ModelStyle, styleOf } from "../common/palette";

export interface HistoryPoint extends EvidenceCheckpoint {
  readonly timestamp: number;
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
  readonly yMax: number;
  readonly tickFormat: Intl.DateTimeFormat;
}
const DAY_MS = 86_400_000;

export const buildHistoryChartModel = (
  history: readonly EvidenceCheckpoint[],
  styles: ReadonlyMap<string, ModelStyle>,
): HistoryChartModel => {
  const points = history
    .map((point) => ({ ...point, timestamp: Date.parse(`${point.day}T00:00:00.000Z`) }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const series = new Map<string, HistorySeries>();
  for (const point of points) {
    const line = series.get(point.model);
    if (line) line.points.push(point);
    else
      series.set(point.model, {
        model: point.model,
        style: styleOf(styles, point.model),
        points: [point],
      });
  }
  const minimum = points[0]?.timestamp ?? Date.now();
  const maximum = points.at(-1)?.timestamp ?? minimum;
  const padding = Math.max(DAY_MS / 2, (maximum - minimum) * 0.05);
  const worst = points.reduce(
    (max, point) => Math.max(max, point.summary.meanCalibrationError ?? 0),
    0,
  );
  return {
    points,
    series: [...series.values()],
    domain: [minimum - padding, maximum + padding],
    yMax: Math.min(1, (Math.ceil(worst * 20) + 1) / 20),
    tickFormat: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(maximum - minimum >= 365 * DAY_MS ? { year: "2-digit" as const } : {}),
      timeZone: "UTC",
    }),
  };
};
