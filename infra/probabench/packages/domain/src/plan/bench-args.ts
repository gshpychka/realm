// The runner's command line for one benchmark: the dev bridge spawns it and the
// setup form prints it as a command. runner/src/cli/command.test.ts parses it, so
// renaming a runner flag fails there rather than in a browser run.
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
