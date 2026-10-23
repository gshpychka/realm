import { describe, expect, it } from "@effect/vitest";
import { Run } from "@probabench/domain";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { Measurements, RunDetail } from "./RunDetail";

const run = Schema.decodeUnknownSync(Run)({
  id: "run-1",
  model: "model.<script>",
  modelSlug: "vendor/model",
  reasoning: "off",
  trialsPerStep: 2,
  stepPercent: 50,
  startedAt: "2026-06-26T00:00:00.000Z",
  points: [
    { x: 0.5, outcomes: [1, { invalidText: "nope" }] },
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
