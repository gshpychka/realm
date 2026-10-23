// The runner prints one line per finished probability point, and the dev bridge
// reads progress back from those lines. Change the format and the parser together.
import { measurePoint } from "../results/metrics";
import type { Point } from "../results/schema";

export interface PointProgress {
  /** The series label, Run.model. */
  readonly model: string;
  readonly point: Point;
  readonly completed: number;
  readonly total: number;
}

export const formatPointProgress = ({ model, point, completed, total }: PointProgress): string => {
  const { ones, zeros, invalid } = measurePoint(point);
  return (
    `[${model}] point ${completed}/${total} x=${Math.round(point.x * 100)}% → ` +
    `ones=${ones} zeros=${zeros} invalid=${invalid}`
  );
};

/** The point counts of a progress line, or null for any other line. */
export const parsePointProgress = (
  line: string,
): Pick<PointProgress, "completed" | "total"> | null => {
  const match = /\] point (\d+)\/(\d+) x=/.exec(line);
  if (!match) return null;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  return Number.isSafeInteger(total) && completed > 0 && completed <= total
    ? { completed, total }
    : null;
};
