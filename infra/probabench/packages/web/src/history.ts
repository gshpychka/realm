import type { Run } from "@probabench/domain";

export interface ModelHistory {
  readonly model: string;
  readonly runs: readonly Run[];
}

/** Append order breaks timestamp ties: a later saved run stays the latest snapshot. */
export const newestFirst = (runs: readonly Run[]): Run[] =>
  runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt) || b.index - a.index)
    .map(({ run }) => run);

/** Graph, archive list, inspector and copied links use the same visible run set. */
export const visibleHistory = (
  runs: readonly Run[],
  query: string,
  hidden: readonly string[],
): Run[] => {
  const term = query.trim().toLowerCase();
  const excluded = new Set(hidden);
  return newestFirst(runs).filter(
    (run) =>
      !excluded.has(run.model) &&
      `${run.model} ${run.modelSlug ?? ""} ${run.id} ${run.reasoning ?? ""}`
        .toLowerCase()
        .includes(term),
  );
};

export const groupHistory = (runs: readonly Run[]): ModelHistory[] => {
  const groups = new Map<string, Run[]>();
  for (const run of newestFirst(runs)) {
    const history = groups.get(run.model) ?? [];
    history.push(run);
    groups.set(run.model, history);
  }
  return [...groups].map(([model, history]) => ({ model, runs: history }));
};

/** Select one snapshot per model while preserving explicit historical selections. */
export const selectedRuns = (
  groups: readonly ModelHistory[],
  selections: ReadonlyMap<string, string>,
  hidden: ReadonlySet<string>,
): Run[] =>
  groups.flatMap((group) => {
    if (hidden.has(group.model)) return [];
    const selected =
      group.runs.find((run) => run.id === selections.get(group.model)) ?? group.runs[0];
    return selected ? [selected] : [];
  });
