import { describe, expect, it } from "@effect/vitest";
import { collectEvidence, evidenceHistory } from "./evidence";
import { makeRun } from "./testing";

const invalid = { invalidText: "not a bit" };
const first = makeRun({
  trialsPerStep: 1,
  startedAt: "2026-10-20T10:00:00.000Z",
  points: [
    { x: 0, outcomes: [1] },
    { x: 1, outcomes: [1] },
  ],
});
const second = makeRun({
  trialsPerStep: 3,
  startedAt: first.startedAt,
  points: [
    { x: 0, outcomes: [0, 0, 0] },
    { x: 1, outcomes: [1, 1, 1] },
  ],
});

describe("model evidence", () => {
  it("is invariant to collection boundaries, record IDs and record order", () => {
    const combined = makeRun({
      trialsPerStep: 4,
      startedAt: first.startedAt,
      points: [
        { x: 0, outcomes: [1, 0, 0, 0] },
        { x: 1, outcomes: [1, 1, 1, 1] },
      ],
    });
    expect(collectEvidence([first, second])).toEqual(collectEvidence([combined]));
    expect(collectEvidence([second, first])).toEqual(collectEvidence([combined]));
    expect(evidenceHistory([second, first])).toEqual(evidenceHistory([combined]));
  });

  it("weights individual answers rather than averaging collection rates", () => {
    const [model] = collectEvidence([first, second]);
    expect(model?.points[0]).toMatchObject({ ones: 1, zeros: 3, total: 4, observed: 0.25 });
    expect(model?.summary.meanCalibrationError).toBe(0.125);
  });

  it("combines overlapping grids without inventing samples at unsampled targets", () => {
    const finer = makeRun({
      stepPercent: 50,
      points: [
        { x: 0, outcomes: [0, 0] },
        { x: 0.5, outcomes: [1, invalid] },
        { x: 1, outcomes: [1, 1] },
      ],
    });
    const [model] = collectEvidence([first, finer]);
    expect(model?.points.map(({ x, total }) => [x, total])).toEqual([
      [0, 3],
      [0.5, 2],
      [1, 3],
    ]);
    expect(model?.points[1]).toMatchObject({ valid: 1, invalid: 1, observed: 1 });
    expect(model?.summary.total).toBe(8);
  });

  it("keeps models and reasoning configurations independent", () => {
    const reasoned = makeRun({ reasoning: "low" });
    const other = makeRun({ modelSlug: "other/model" });
    const evidence = collectEvidence([other, reasoned, first]);
    expect(evidence).toHaveLength(3);
    expect(evidence.find((model) => model.model === first.model)?.summary.total).toBe(2);
    expect(evidence.find((model) => model.model === reasoned.model)?.summary.total).toBe(4);
  });

  it("retains invalid counts without erasing earlier valid evidence", () => {
    const failed = makeRun({
      startedAt: "2026-10-21T00:00:00.000Z",
      points: [
        { x: 0, outcomes: [invalid, invalid] },
        { x: 1, outcomes: [invalid, invalid] },
      ],
    });
    const checkpoints = evidenceHistory([failed, first]);
    expect(checkpoints.map(({ summary }) => summary.meanCalibrationError)).toEqual([0.5, 0.5]);
    expect(checkpoints[1]?.summary).toMatchObject({ valid: 2, total: 6, validity: 1 / 3 });
    expect(collectEvidence([failed])[0]?.summary.meanCalibrationError).toBeNull();
  });

  it("builds cumulative daily history and includes all of a selected UTC day", () => {
    const evening = makeRun({ ...second, startedAt: "2026-10-20T23:59:59.999Z" });
    const tomorrow = makeRun({ startedAt: "2026-10-21T00:00:00.000Z" });
    const records = [tomorrow, evening, first];
    const checkpoints = evidenceHistory(records);
    expect(checkpoints.map(({ day, summary }) => [day, summary.total])).toEqual([
      ["2026-10-20", 8],
      ["2026-10-21", 12],
    ]);
    const [before] = collectEvidence(records, "2026-10-20");
    expect(before?.summary).toEqual(checkpoints[0]?.summary);
    expect(before?.firstCollectedAt).toBe(first.startedAt);
    expect(before?.lastCollectedAt).toBe(evening.startedAt);
    expect(collectEvidence(records, "2026-10-19")).toEqual([]);
    expect(collectEvidence(records)[0]?.summary).toEqual(checkpoints[1]?.summary);
  });
});
