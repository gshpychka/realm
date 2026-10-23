import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_REQUEST, presetFor } from "./run-settings";

describe("presetFor", () => {
  it("names the preset a request's sampling matches", () => {
    expect(presetFor(DEFAULT_REQUEST)?.label).toBe("Standard");
    expect(presetFor({ trialsPerStep: 17, stepPercent: 30 })).toBeUndefined();
  });
});
