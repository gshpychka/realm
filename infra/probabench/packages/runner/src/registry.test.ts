import { describe, expect, it } from "@effect/vitest";
import { allTargetIds, describeAliases, MODEL_ALIASES, selectTargets, TARGETS } from "./registry";

describe("OpenRouter model selection", () => {
  it("keeps convenient unique aliases and lists their canonical slugs", () => {
    expect(new Set(allTargetIds).size).toBe(MODEL_ALIASES.length);
    expect(describeAliases()).toContain("claude-haiku-4.5 → anthropic/claude-haiku-4.5");
    expect(describeAliases()).not.toContain("ollama");
  });

  it("expands all aliases with distinct reasoning variants", () => {
    const selection = selectTargets(["all"]);
    expect(selection.targets).toEqual(TARGETS);
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

  it("dedupes aliases and slugs resolving to the same experiment", () => {
    expect(selectTargets(["claude-haiku-4.5", "anthropic/claude-haiku-4.5"]).targets).toHaveLength(
      1,
    );
    expect(selectTargets(["all", "gpt-5-mini-low"]).targets).toEqual(TARGETS);
  });

  it("defaults slug reasoning off and preserves a named alias mode", () => {
    expect(selectTargets(["openai/gpt-5-mini"]).targets[0]?.reasoning).toBeUndefined();
    expect(selectTargets(["gpt-5-mini-low"]).targets[0]?.reasoning).toEqual({ effort: "low" });
  });

  it("can override aliases or slugs with an explicit reasoning mode", () => {
    expect(selectTargets(["claude-sonnet-4.5-high"], "off").targets[0]).toEqual({
      id: "anthropic/claude-sonnet-4.5",
      slug: "anthropic/claude-sonnet-4.5",
    });
    expect(selectTargets(["custom/model"], "high").targets[0]).toEqual({
      id: "custom/model [reasoning=high]",
      slug: "custom/model",
      reasoning: { effort: "high" },
    });
  });

  it("reports unknown aliases and malformed slugs before execution", () => {
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
});
