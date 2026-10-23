import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { RunDetail } from "./RunDetail";

const run = makeRun({
  points: [
    { x: 0, outcomes: [1, { invalidText: "nope" }] },
    { x: 1, outcomes: [{ invalidText: "x" }, { invalidText: "y" }] },
  ],
});

describe("RunDetail", () => {
  it("summarizes the run's reasoning, mean calibration error and valid replies", () => {
    const html = renderToStaticMarkup(<RunDetail run={run} onCompare={() => {}} />);
    expect(html).toContain("reasoning off");
    expect(html).toContain("100.0 pp");
    expect(html).toContain("25%");
    expect(html).toContain("1 valid / 4");
  });
});
