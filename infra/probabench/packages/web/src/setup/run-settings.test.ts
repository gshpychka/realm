import { describe, expect, it } from "@effect/vitest";
import { makeRun } from "@probabench/domain/testing";
import { benchmarkCommand, DEFAULT_REQUEST, presetFor, rerunRequest } from "./run-settings";

const request = { model: "vendor/model", trialsPerStep: 10, stepPercent: 25, concurrency: 5 };

describe("benchmarkCommand", () => {
  it("leaves plain words bare and passes reasoning through", () => {
    expect(benchmarkCommand({ ...request, reasoning: "low" })).toBe(
      "probabench --model vendor/model --trials 10 --step 25 --concurrency 5 --reasoning low",
    );
  });

  it("quotes words a shell would interpret, so a copied command cannot run their contents", () => {
    const command = benchmarkCommand({ ...request, model: "a'$(touch bad)" });
    expect(command).toContain("--model 'a'\\''$(touch bad)'");
    expect(command).not.toContain("--yes");
  });
});

describe("presetFor", () => {
  it("names the preset a request's sampling matches", () => {
    expect(presetFor(DEFAULT_REQUEST)?.id).toBe("standard");
    expect(presetFor({ trialsPerStep: 17, stepPercent: 30 })).toBeUndefined();
  });
});

describe("rerunRequest", () => {
  it("repeats a saved run's model, sampling and reasoning", () => {
    const run = makeRun({ model: "vendor/model [reasoning=low]", reasoning: "low" });
    expect(rerunRequest(run)).toEqual({
      model: run.modelSlug,
      trialsPerStep: run.trialsPerStep,
      stepPercent: run.stepPercent,
      concurrency: DEFAULT_REQUEST.concurrency,
      reasoning: "low",
    });
  });

  it("offers no rerun the form cannot express", () => {
    expect(rerunRequest(makeRun({ modelSlug: "not-a-slug" }))).toBeNull();
  });
});
