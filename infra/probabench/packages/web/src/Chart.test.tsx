import { describe, expect, it } from "@effect/vitest";
import { PersistedResults } from "@probabench/domain";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { Measurements, RunDetail } from "./RunDetail";

const fixture = Schema.decodeUnknownSync(PersistedResults)({
  schemaVersion: 1,
  runs: [
    {
      model: "model.<script>",
      trialsPerStep: 2,
      stepPercent: 50,
      startedAt: "2026-06-26T00:00:00.000Z",
      points: [
        { x: 0.5, outcomes: [1, { invalidText: "nope" }] },
        { x: 1, outcomes: [{ invalidText: "x" }, { invalidText: "y" }] },
      ],
    },
  ],
});
const run = fixture.runs[0];
if (!run) throw new Error("Missing fixture run");

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

  it("marks missing legacy reasoning metadata as unrecorded", () => {
    const html = renderToStaticMarkup(<RunDetail run={run} />);
    expect(html).toContain("Unrecorded reasoning");
    expect(html).toContain("25%");
    expect(html).toContain("1 valid / 4");
  });
});
