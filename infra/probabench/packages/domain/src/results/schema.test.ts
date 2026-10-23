import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { Results, Run } from "./schema";
import { makeRun } from "./testing";

const run = makeRun({
  stepPercent: 50,
  points: [
    { x: 0, outcomes: [0, 0] },
    { x: 0.5, outcomes: [0, 1] },
    { x: 1, outcomes: [1, 1] },
  ],
});

/** Assert a decode failure, naming the input when the assertion fails. */
const rejects =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (input: unknown) => {
    const decoded = Schema.decodeUnknownEither(schema)(input);
    expect(Either.isLeft(decoded), JSON.stringify(input)).toBe(true);
  };

describe("Run", () => {
  it.each([
    { model: "other" },
    { model: "not-a-slug", modelSlug: "not-a-slug" },
    { startedAt: "2026-02-31T00:00:00.000Z" },
    // Valid ISO but not toISOString's form, so it would sort out of order.
    { startedAt: "2026-06-26T00:00:00Z" },
    { trialsPerStep: 3 },
    { points: [] },
    { points: run.points.slice(0, 2) },
    { points: [run.points[0], { x: 0.4, outcomes: [0, 1] }, run.points[2]] },
    { points: [...run.points].reverse() },
  ])("rejects %j", (patch) => rejects(Run)({ ...run, ...patch }));
});

describe("Results", () => {
  it("keeps separate runs of the same model", () => {
    const runs = [run, { ...run, id: "other" }];
    const results = Schema.decodeUnknownSync(Results)({ runs });
    expect(results.runs.map((entry) => entry.id)).toEqual([run.id, "other"]);
  });

  it("rejects duplicate run ids", () => rejects(Results)({ runs: [run, run] }));
});
