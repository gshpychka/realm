import { describe, expect, it } from "@effect/vitest";
import { MODEL_ALIASES, resolveModel } from "./models";

describe("resolveModel", () => {
  it("keeps aliases unique", () => {
    expect(new Set(MODEL_ALIASES.map((model) => model.alias)).size).toBe(MODEL_ALIASES.length);
  });

  it("resolves an alias to its own entry and a model ID to itself", () => {
    expect(resolveModel(MODEL_ALIASES[0].alias)).toBe(MODEL_ALIASES[0]);
    expect(resolveModel("vendor/model:free")).toEqual({ slug: "vendor/model:free" });
  });

  it.each([
    "vendor/model+x",
    "a:b/c",
    "vendor/",
    "future-model",
    "--help",
    "a,b",
    "model; touch /tmp/oops",
    "all",
  ])("resolves no model for %s", (token) => {
    expect(resolveModel(token)).toBeUndefined();
  });
});
