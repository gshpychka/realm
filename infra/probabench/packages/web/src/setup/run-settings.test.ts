import { describe, expect, it } from "@effect/vitest";
import { benchmarkCommand, DEFAULT_REQUEST, presetFor } from "./run-settings";

const request = { model: "vendor/model", trialsPerStep: 10, stepPercent: 25, concurrency: 5 };

describe("benchmarkCommand", () => {
  it("quotes words a shell would interpret, so a copied command cannot run their contents", () => {
    const command = benchmarkCommand({ ...request, model: "a'$(touch bad)" });
    expect(command).toContain("--model 'a'\\''$(touch bad)'");
    expect(command).not.toContain("--yes");
  });
});

describe("presetFor", () => {
  it("names the preset a request's sampling matches", () => {
    expect(presetFor(DEFAULT_REQUEST)?.label).toBe("Standard");
    expect(presetFor({ trialsPerStep: 17, stepPercent: 30 })).toBeUndefined();
  });
});
