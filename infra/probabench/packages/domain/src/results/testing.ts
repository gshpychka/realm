// Test fixtures for every package. Each Run is decoded, so a fixture can only
// describe a run the contract accepts. Never import this from application code.
import * as Schema from "effect/Schema";
import { Run } from "./schema";

let sequence = 0;

/** A small valid run; override only the fields a test is about. Ids are sequential. */
export const makeRun = (overrides: Partial<typeof Run.Encoded> = {}): Run =>
  Schema.decodeUnknownSync(Run)({
    id: `run-${++sequence}`,
    model: "vendor/model",
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
  });
