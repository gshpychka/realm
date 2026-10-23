import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { Probability, Results, Run, Trial } from "./schema";

const run = {
  id: "run-1",
  model: "anthropic/claude-haiku-4.5",
  modelSlug: "anthropic/claude-haiku-4.5",
  reasoning: "off",
  trialsPerStep: 2,
  stepPercent: 50,
  startedAt: "2026-06-26T00:00:00.000Z",
  points: [{ x: 0.5, outcomes: [0, 1] }],
} as const;

describe("Probability", () => {
  it("decodes fractions including endpoints", () => {
    for (const value of [0, 0.5, 1])
      expect(Schema.decodeUnknownSync(Probability)(value)).toBe(value);
  });

  it("rejects out-of-range and nonfinite values", () => {
    for (const value of [-0.1, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(Probability)(value))).toBe(true);
    }
  });
});

describe("Trial", () => {
  it("round-trips both bits and the text of invalid replies", () => {
    const encode = Schema.encodeSync(Trial);
    const decode = Schema.decodeUnknownSync(Trial);
    for (const value of [0, 1, { invalidText: "oops" }, { invalidText: "" }]) {
      expect(encode(decode(value))).toEqual(value);
    }
  });

  it("rejects non-bit numbers and malformed invalid replies", () => {
    for (const value of [2, 0.5, null, { invalidText: 2 }]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(Trial)(value))).toBe(true);
    }
  });
});

describe("Run", () => {
  it("allows partial grids while validating counts and timestamp", () => {
    expect(Schema.decodeUnknownSync(Run)(run).points).toHaveLength(1);
  });

  it("rejects invalid metadata", () => {
    for (const field of [
      { trialsPerStep: 0 },
      { trialsPerStep: -1 },
      { trialsPerStep: 1.5 },
      { trialsPerStep: Infinity },
      { trialsPerStep: Number.MAX_SAFE_INTEGER + 1 },
      { stepPercent: 0 },
      { stepPercent: 101 },
      { stepPercent: 0.5 },
      { model: "  " },
      { id: "  " },
      { modelSlug: "" },
      { reasoning: "  " },
      { points: [] },
      { startedAt: "now" },
      { startedAt: "2026-02-31T00:00:00.000Z" },
    ]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(Run)({ ...run, ...field }))).toBe(true);
    }
  });

  it("rejects outcome counts that disagree with trialsPerStep and duplicate probabilities", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(Run)({ ...run, trialsPerStep: 3 }))).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(Run)({ ...run, points: [run.points[0], run.points[0]] }),
      ),
    ).toBe(true);
  });
});

describe("Results", () => {
  it("decodes the supported document version", () => {
    expect(Schema.decodeUnknownSync(Results)({ schemaVersion: 2, runs: [run] }).runs).toHaveLength(
      1,
    );
  });

  it("rejects unsupported schema versions and duplicate run ids", () => {
    for (const schemaVersion of [0, 1, 3, 1.5, Number.NaN, Infinity]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(Results)({ schemaVersion, runs: [] }))).toBe(
        true,
      );
    }
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(Results)({
          schemaVersion: 2,
          runs: [run, { ...run, model: "other" }],
        }),
      ),
    ).toBe(true);
  });

  it("preserves separate executions of the same model", () => {
    const results = Schema.decodeUnknownSync(Results)({
      schemaVersion: 2,
      runs: [run, { ...run, id: "run-2" }],
    });
    expect(results.runs.map((entry) => entry.id)).toEqual(["run-1", "run-2"]);
  });
});
