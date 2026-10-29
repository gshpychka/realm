/** Counts are newly saved answers for this invocation, excluding earlier daily samples. */
export interface SampleProgress {
  readonly completed: number;
  readonly total: number;
}

/** Human-readable when piped; also consumed by the local page's dev bridge. */
export const formatSampleProgress = ({ completed, total }: SampleProgress): string =>
  `Progress: ${completed}/${total} samples saved`;

export const parseSampleProgress = (line: string): SampleProgress | null => {
  const match = /^Progress: (\d+)\/(\d+) samples saved\b/.exec(line);
  return match ? { completed: Number(match[1]), total: Number(match[2]) } : null;
};
