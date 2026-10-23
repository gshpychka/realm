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
const render = (item = run) =>
  renderToStaticMarkup(<RunDetail run={item} onCompare={() => {}} onRerun={() => {}} />);

describe("RunDetail", () => {
  it("summarizes the run's reasoning, mean calibration error and valid replies", () => {
    const html = render();
    expect(html).toContain("off reasoning");
    expect(html).toContain("100.0 pp");
    expect(html).toContain("25%");
    expect(html).toContain("1 valid / 4");
  });

  it("offers a rerun only when the setup form can express the run", () => {
    expect(render()).toContain("Run again");
    expect(render(makeRun({ modelSlug: "not-a-slug" }))).not.toContain("Run again");
  });
});
