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
  it("provides semantic measurements and keeps invalid replies separate from valid bits", () => {
    const html = renderToStaticMarkup(<Measurements run={run} />);
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain("Ones / valid");
    expect(html).toContain("No valid replies");
  });
});
