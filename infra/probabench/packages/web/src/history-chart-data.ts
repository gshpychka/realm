import { type Run, type RunSummary, summarizeRun } from "@probabench/domain";

export interface HistoryPoint {
  readonly timestamp: number;
  readonly score: number | null;
  readonly run: Run;
  readonly summary: RunSummary;
}

export interface HistorySeries {
  readonly model: string;
  readonly color: string;
  readonly points: HistoryPoint[];
}

/** Each model owns its timeline. Null scores break lines; timestamp ties retain archive order. */
export const buildHistoryChartModel = (
  runs: readonly Run[],
  colors: ReadonlyMap<string, string>,
) => {
  const points = runs
    .map((run): HistoryPoint => {
      const summary = summarizeRun(run);
      return {
        timestamp: Date.parse(run.startedAt),
        score: summary.calibrationError,
        run,
        summary,
      };
    })
    .sort((a, b) => a.timestamp - b.timestamp);
  const groups = new Map<string, HistorySeries>();
  for (const point of points) {
    let group = groups.get(point.run.model);
    if (!group) {
      group = {
        model: point.run.model,
        color: colors.get(point.run.model) ?? "#d8a657",
        points: [],
      };
      groups.set(point.run.model, group);
    }
    group.points.push(point);
  }
  const minimum = points[0]?.timestamp ?? Date.now();
  const maximum = points.at(-1)?.timestamp ?? minimum;
  const padding = Math.max(60_000, (maximum - minimum) * 0.05);
  const domain: [number, number] = [
    Math.max(-8.64e15, minimum - padding),
    Math.min(8.64e15, maximum + padding),
  ];
  const upperScore = Math.min(
    1,
    Math.max(
      0.05,
      Math.ceil(
        points.reduce((maximum, point) => Math.max(maximum, point.score ?? 0), 0) * 20 + 1,
      ) / 20,
    ),
  );
  return { points, series: [...groups.values()], minimum, maximum, domain, upperScore };
};
