// A daily request is a desired total at each probability, not an instruction to
// repeat that many calls. Raw saved replies, including invalid ones, fill slots.
import { type Outcome, type Point, probabilityGrid, type Results } from "@probabench/domain";
import type { BenchPlan } from "./plan";
import type { ModelSeries } from "./series";

export interface DailySeries {
  readonly series: ModelSeries;
  readonly points: readonly Point[];
  readonly remaining: number;
}

export interface DailyPlan {
  readonly startedAt: string;
  readonly day: string;
  readonly series: readonly DailySeries[];
  readonly remaining: number;
}

export const planDaily = (plan: BenchPlan, history: Results, startedAt: string): DailyPlan => {
  const day = startedAt.slice(0, 10);
  const collected = new Map<string, Map<number, Outcome[]>>();
  for (const record of history.runs) {
    if (record.startedAt.slice(0, 10) !== day) continue;
    let targets = collected.get(record.model);
    if (!targets) {
      targets = new Map();
      collected.set(record.model, targets);
    }
    for (const point of record.points) {
      const outcomes = targets.get(point.x) ?? [];
      outcomes.push(...point.outcomes);
      targets.set(point.x, outcomes);
    }
  }
  const series = plan.series.map((entry): DailySeries => {
    const points = probabilityGrid(plan.options.stepPercent).map((x) => ({
      x,
      outcomes: collected.get(entry.model)?.get(x) ?? [],
    }));
    return {
      series: entry,
      points,
      remaining: points.reduce(
        (sum, point) => sum + Math.max(0, plan.options.trialsPerStep - point.outcomes.length),
        0,
      ),
    };
  });
  return {
    startedAt,
    day,
    series,
    remaining: series.reduce((sum, entry) => sum + entry.remaining, 0),
  };
};
