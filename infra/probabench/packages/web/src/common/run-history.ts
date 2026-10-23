import type { Run } from "@probabench/domain";

const byNewest = (a: Run, b: Run): number => b.startedAt.localeCompare(a.startedAt);

/** Latest start first. */
export const newestFirst = (runs: readonly Run[]): Run[] => runs.toSorted(byNewest);

/** The model filter shared by the history graph, list and inspector. */
export const visibleHistory = (runs: readonly Run[], hidden: readonly string[]): Run[] => {
  const excluded = new Set(hidden);
  return newestFirst(runs).filter((run) => !excluded.has(run.model));
};

/** The run the history inspector shows: the linked one while visible, else the newest. */
export const inspectedRun = (visible: readonly Run[], runId: string | null): Run | undefined =>
  visible.find((run) => run.id === runId) ?? visible[0];

export interface ModelSelection {
  readonly model: string;
  /** Newest first. */
  readonly runs: readonly [Run, ...Run[]];
  /** The compared run, else the latest. */
  readonly compared: Run;
}

/** Every model in append order, the palette's, with the run the calibration chart compares. */
export const modelSelections = (
  runs: readonly Run[],
  comparisons: readonly string[],
): ModelSelection[] => {
  const groups = new Map<string, [Run, ...Run[]]>();
  for (const run of runs) {
    const group = groups.get(run.model);
    if (group) group.push(run);
    else groups.set(run.model, [run]);
  }
  const comparedIds = new Set(comparisons);
  return [...groups].map(([model, history]) => {
    history.sort(byNewest);
    return {
      model,
      runs: history,
      compared: history.find((run) => comparedIds.has(run.id)) ?? history[0],
    };
  });
};

/** The comparisons with `run` in place of any other run of its model. */
export const withComparison = (
  comparisons: readonly string[],
  runs: readonly Run[],
  run: Run,
): string[] => [
  ...comparisons.filter((id) => !runs.some((item) => item.id === id && item.model === run.model)),
  run.id,
];

/** Runs grouped by UTC day in their given order; a canonical ISO timestamp starts with the day. */
export const runsByDay = (runs: readonly Run[]): [day: string, runs: Run[]][] => {
  const days = new Map<string, Run[]>();
  for (const run of runs) {
    const day = run.startedAt.slice(0, 10);
    const group = days.get(day);
    if (group) group.push(run);
    else days.set(day, [run]);
  }
  return [...days];
};
