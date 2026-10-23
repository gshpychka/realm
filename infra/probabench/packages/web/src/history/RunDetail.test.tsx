import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { Measurements, RunDetail } from "./RunDetail";

const run = makeRun({
  model: "model.<script>",
  points: [
    { x: 0, outcomes: [1, { invalidText: "nope" }] },
    { x: 1, outcomes: [{ invalidText: "x" }, { invalidText: "y" }] },
  ],
});

describe("Accessible observations", () => {
  it("provides semantic measurements and keeps invalid replies separate from valid bits", () => {
    const html = renderToStaticMarkup(<Measurements run={run} />);
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain("Ones / valid");
    expect(html).toContain("No valid replies");
    expect(html).toContain("model.&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("summarizes the run's reasoning, mean gap and valid samples", () => {
    const html = renderToStaticMarkup(<RunDetail run={run} />);
    expect(html).toContain("off reasoning");
    expect(html).toContain("25%");
    expect(html).toContain("1 valid / 4");
  });
});
