// Test fixtures for every package. Each Run is decoded, so a fixture can only
// describe a run the contract accepts. Never import this from application code.
import * as Schema from "effect/Schema";
import { Run, seriesLabel } from "./schema";

type RunFields = Omit<typeof Run.Encoded, "model">;

let sequence = 0;

/**
 * A small valid run; override only the fields a test is about. Ids are sequential,
 * and the series label follows from modelSlug and reasoning.
 */
export const makeRun = (overrides: Partial<RunFields> = {}): Run => {
  const fields: RunFields = {
    id: `run-${++sequence}`,
    modelSlug: "vendor/model",
    reasoning: "off",
    trialsPerStep: 2,
    stepPercent: 100,
    startedAt: "2026-06-26T00:00:00.000Z",
    points: [
      { x: 0, outcomes: [0, 0] },
      { x: 1, outcomes: [1, 1] },
    ],
    ...overrides,
  };
  return Schema.decodeUnknownSync(Run)({
    ...fields,
    model: seriesLabel(fields.modelSlug, fields.reasoning),
  });
};
