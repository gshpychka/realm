import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { Outcome, Results, Run } from "./schema";

const run = {
  id: "run-1",
  model: "anthropic/claude-haiku-4.5",
  modelSlug: "anthropic/claude-haiku-4.5",
  reasoning: "off",
  trialsPerStep: 2,
  stepPercent: 50,
  startedAt: "2026-06-26T00:00:00.000Z",
  points: [
    { x: 0, outcomes: [0, 0] },
    { x: 0.5, outcomes: [0, 1] },
    { x: 1, outcomes: [1, 1] },
  ],
} as const;

/** Assert a decode failure, naming the input when the assertion fails. */
const rejects =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (input: unknown) => {
    const decoded = Schema.decodeUnknownEither(schema)(input);
    expect(Either.isLeft(decoded), JSON.stringify(input)).toBe(true);
  };

describe("Outcome", () => {
  it.each([2, 0.5, null, { invalidText: 2 }])("rejects %j", rejects(Outcome));
});

describe("Run", () => {
  it("decodes a valid run", () => {
    expect(Schema.decodeUnknownSync(Run)(run)).toEqual(run);
  });

  it.each([
    { id: "  " },
    { model: "  " },
    { model: "other" },
    { modelSlug: " vendor/model" },
    { modelSlug: "not-a-slug" },
    { reasoning: undefined },
    { trialsPerStep: 0 },
    { trialsPerStep: 1.5 },
    { stepPercent: 101 },
    { startedAt: "2026-02-31T00:00:00.000Z" },
    { trialsPerStep: 3 },
    { points: [] },
    { points: run.points.slice(0, 2) },
    { points: [run.points[0], { x: 0.4, outcomes: [0, 1] }, run.points[2]] },
    { points: [...run.points].reverse() },
  ])("rejects %j", (patch) => rejects(Run)({ ...run, ...patch }));
});

describe("Results", () => {
  it("keeps separate runs of the same model", () => {
    const results = Schema.decodeUnknownSync(Results)({
      schemaVersion: 2,
      runs: [run, { ...run, id: "run-2" }],
    });
    expect(results.runs.map((entry) => entry.id)).toEqual(["run-1", "run-2"]);
  });

  it.each([
    { schemaVersion: 1, runs: [] },
    { schemaVersion: 3, runs: [] },
    { schemaVersion: 2, runs: [run, run] },
  ])("rejects %j", rejects(Results));
});
