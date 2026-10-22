import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { decodeResults, PersistedResults, Point, Probability, Results, Run, Trial } from "./schema";

const legacyRun = {
  model: "claude-haiku-4.5",
  trialsPerStep: 2,
  stepPercent: 50,
  startedAt: "2026-06-26T00:00:00.000Z",
  points: [{ x: 0.5, rmse: 0.5, outcomes: [0, 1] }],
} as const;
const run = { id: "run-1", ...legacyRun } as const;

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

describe("Point", () => {
  it("accepts measured RMSE and null when all replies are invalid", () => {
    expect(
      Schema.decodeUnknownSync(Point)({ x: 0.5, rmse: 0.5, outcomes: [0, 1, { invalidText: "x" }] })
        .rmse,
    ).toBe(0.5);
    expect(
      Schema.decodeUnknownSync(Point)({ x: 0.5, rmse: null, outcomes: [{ invalidText: "x" }] })
        .rmse,
    ).toBeNull();
  });

  it("rejects impossible, missing, or inconsistent RMSE", () => {
    for (const value of [Number.NaN, Infinity, -0.1, 1.1, null, 0.2]) {
      expect(
        Either.isLeft(Schema.decodeUnknownEither(Point)({ x: 0.5, rmse: value, outcomes: [0, 1] })),
      ).toBe(true);
    }
    expect(
      Either.isLeft(Schema.decodeUnknownEither(Point)({ x: 0.5, rmse: 0.5, outcomes: [] })),
    ).toBe(true);
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

  it("preserves separate executions of the same model and optional provider metadata", () => {
    const results = Schema.decodeUnknownSync(Results)({
      schemaVersion: 2,
      runs: [
        run,
        { ...run, id: "run-2", modelSlug: "anthropic/claude-haiku-4.5", reasoning: "off" },
      ],
    });
    expect(results.runs.map((entry) => entry.id)).toEqual(["run-1", "run-2"]);
    expect(results.runs[1]?.modelSlug).toBe("anthropic/claude-haiku-4.5");
    expect(results.runs[1]?.reasoning).toBe("off");
  });
});

describe("PersistedResults", () => {
  it.effect("upgrades v1 without discarding measurements and assigns deterministic ids", () =>
    decodeResults({ schemaVersion: 1, runs: [legacyRun] }).pipe(
      Effect.map((results) => {
        expect(results.schemaVersion).toBe(2);
        expect(results.runs[0]).toMatchObject(legacyRun);
        expect(results.runs[0]?.id).toBe("legacy-v1:16:claude-haiku-4.5:2026-06-26T00:00:00.000Z");
        expect(Schema.encodeSync(PersistedResults)(results)).toEqual(results);
        return results;
      }),
    ),
  );

  it("keeps migrated identities stable when model order changes", () => {
    const decode = Schema.decodeUnknownSync(PersistedResults);
    const second = { ...legacyRun, model: "odd:model/\ud800" };
    const original = decode({ schemaVersion: 1, runs: [legacyRun, second] });
    const reversed = decode({ schemaVersion: 1, runs: [second, legacyRun] });
    expect(original.runs[0]?.id).toBe(reversed.runs[1]?.id);
    expect(original.runs[1]?.id).toBe(reversed.runs[0]?.id);
    expect(new Set(original.runs.map((entry) => entry.id)).size).toBe(2);
  });

  it("reads v2 history and empty v1 documents", () => {
    const current = { schemaVersion: 2, runs: [run, { ...run, id: "run-2" }] };
    expect(Schema.decodeUnknownSync(PersistedResults)(current)).toEqual(current);
    expect(Schema.decodeUnknownSync(PersistedResults)({ schemaVersion: 1, runs: [] })).toEqual({
      schemaVersion: 2,
      runs: [],
    });
  });

  it("keeps raw measurement/version/uniqueness validation during migration", () => {
    for (const document of [
      { schemaVersion: 3, runs: [] },
      { schemaVersion: 1, runs: [legacyRun, legacyRun] },
      { schemaVersion: 1, runs: [{ ...legacyRun, trialsPerStep: 3 }] },
      {
        schemaVersion: 1,
        runs: [{ ...legacyRun, points: [{ x: 0.5, rmse: 0.1, outcomes: [0, 1] }] }],
      },
      { schemaVersion: 2, runs: [run, run] },
      { schemaVersion: 2, runs: [legacyRun] },
    ]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(PersistedResults)(document))).toBe(true);
    }
  });
});
