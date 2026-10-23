// The runner's flags for one benchmark, which the dev bridge spawns it with.
// runner/src/cli/command.test.ts parses them, so renaming a runner flag fails
// there rather than in a browser run.
import type { ReasoningMode } from "./models";

export const benchArgs = (request: {
  readonly model: string;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
  readonly reasoning?: ReasoningMode | undefined;
}): string[] => [
  "--model",
  request.model,
  "--trials",
  String(request.trialsPerStep),
  "--step",
  String(request.stepPercent),
  "--concurrency",
  String(request.concurrency),
  ...(request.reasoning === undefined ? [] : ["--reasoning", request.reasoning]),
];
