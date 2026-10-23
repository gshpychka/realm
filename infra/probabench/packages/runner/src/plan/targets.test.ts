import { describe, expect, it } from "@effect/vitest";
import { ALL_TARGETS, isModelToken, MODEL_ALIASES } from "@probabench/domain";
import { describeAliases, selectTargets, splitModels } from "./targets";

describe("OpenRouter model selection", () => {
  it("keeps convenient unique aliases and lists their canonical slugs", () => {
    expect(new Set(MODEL_ALIASES.map((model) => model.alias)).size).toBe(MODEL_ALIASES.length);
    expect(describeAliases()).toContain("claude-haiku-4.5 → anthropic/claude-haiku-4.5");
  });

  it("splits a comma-separated model list into trimmed tokens", () => {
    expect(splitModels(" vendor/model , ,all,")).toEqual(["vendor/model", "all"]);
  });

  it("expands all aliases with distinct reasoning variants", () => {
    const selection = selectTargets([ALL_TARGETS]);
    expect(selection.targets).toHaveLength(MODEL_ALIASES.length);
    expect(selection.unknown).toEqual([]);
    expect(selection.targets.map((target) => target.id)).toContain(
      "anthropic/claude-sonnet-4.5 [reasoning=high]",
    );
  });

  it("accepts arbitrary OpenRouter slugs and preserves request order", () => {
    const selection = selectTargets(["custom-vendor/new-model:free", "claude-haiku-4.5"]);
    expect(selection.targets.map((target) => target.id)).toEqual([
      "custom-vendor/new-model:free",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(selection.unknown).toEqual([]);
  });

  it("dedupes aliases and model IDs resolving to the same series", () => {
    expect(selectTargets(["claude-haiku-4.5", "anthropic/claude-haiku-4.5"]).targets).toHaveLength(
      1,
    );
    expect(selectTargets([ALL_TARGETS, "gpt-5-mini-low"]).targets).toEqual(
      selectTargets([ALL_TARGETS]).targets,
    );
  });

  it("defaults slug reasoning off and preserves a named alias mode", () => {
    expect(selectTargets(["openai/gpt-5-mini"]).targets[0]?.reasoning).toBe("off");
    expect(selectTargets(["gpt-5-mini-low"]).targets[0]?.reasoning).toBe("low");
  });

  it("can override aliases or slugs with an explicit reasoning mode", () => {
    expect(selectTargets(["claude-sonnet-4.5-high"], "off").targets[0]).toEqual({
      id: "anthropic/claude-sonnet-4.5",
      slug: "anthropic/claude-sonnet-4.5",
      reasoning: "off",
    });
    expect(selectTargets(["custom/model"], "high").targets[0]).toEqual({
      id: "custom/model [reasoning=high]",
      slug: "custom/model",
      reasoning: "high",
    });
  });

  it("reports unknown aliases and malformed model IDs before execution", () => {
    const selection = selectTargets([
      "claude-haiku-4.5",
      "typo",
      "vendor/",
      "/model",
      "vendor/model with spaces",
    ]);
    expect(selection.targets).toHaveLength(1);
    expect(selection.unknown).toEqual(["typo", "vendor/", "/model", "vendor/model with spaces"]);
  });

  it.each([
    "claude-haiku-4.5",
    "vendor/model:free",
    "future-model",
    "vendor/model+x",
    "a:b/c",
    "vendor/",
    "--help",
  ])("agrees with the domain's model-token rule for %s", (token) => {
    expect(isModelToken(token)).toBe(selectTargets([token]).unknown.length === 0);
  });
});
