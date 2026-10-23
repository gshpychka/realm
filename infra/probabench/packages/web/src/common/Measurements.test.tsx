import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { Measurements } from "./Measurements";

const run = makeRun({
  points: [
    { x: 0, outcomes: [1, { invalidText: "nope" }] },
    { x: 1, outcomes: [{ invalidText: "x" }, { invalidText: "y" }] },
  ],
});

describe("Measurements", () => {
  it("counts invalid replies apart from valid bits and leaves an all-invalid target unmeasured", () => {
    const html = renderToStaticMarkup(<Measurements run={run} />);
    // At 0%: one 1 among one valid reply, and one invalid reply among two.
    expect(html).toContain("1 / 1");
    expect(html).toContain("1 / 2");
    expect(html).toContain("No valid replies");
  });
});
