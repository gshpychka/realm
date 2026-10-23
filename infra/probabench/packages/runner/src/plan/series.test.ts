import { describe, expect, it } from "@effect/vitest";
import { MODEL_ALIASES } from "@probabench/domain";
import { ALL_ALIASES, describeAliases, selectSeries, splitModels } from "./series";

describe("OpenRouter model selection", () => {
  it("lists aliases with their canonical slugs", () => {
    expect(describeAliases()).toContain("claude-haiku-4.5 → anthropic/claude-haiku-4.5");
  });

  it("splits a comma-separated model list into trimmed tokens", () => {
    expect(splitModels(" vendor/model , ,all,")).toEqual(["vendor/model", "all"]);
  });

  it("expands all aliases with distinct reasoning variants", () => {
    const selection = selectSeries([ALL_ALIASES]);
    expect(selection.series).toHaveLength(MODEL_ALIASES.length);
    expect(selection.unknown).toEqual([]);
    expect(selection.series.map((entry) => entry.id)).toContain(
      "anthropic/claude-sonnet-4.5 [reasoning=high]",
    );
  });

  it("accepts arbitrary OpenRouter slugs and preserves request order", () => {
    const selection = selectSeries(["custom-vendor/new-model:free", "claude-haiku-4.5"]);
    expect(selection.series.map((entry) => entry.id)).toEqual([
      "custom-vendor/new-model:free",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(selection.unknown).toEqual([]);
  });

  it("dedupes aliases and model IDs resolving to the same series", () => {
    expect(selectSeries(["claude-haiku-4.5", "anthropic/claude-haiku-4.5"]).series).toHaveLength(1);
    expect(selectSeries([ALL_ALIASES, "gpt-5-mini-low"]).series).toEqual(
      selectSeries([ALL_ALIASES]).series,
    );
  });

  it("defaults slug reasoning off and preserves a named alias mode", () => {
    expect(selectSeries(["openai/gpt-5-mini"]).series[0]?.reasoning).toBe("off");
    expect(selectSeries(["gpt-5-mini-low"]).series[0]?.reasoning).toBe("low");
  });

  it("can override aliases or slugs with an explicit reasoning mode", () => {
    expect(selectSeries(["claude-sonnet-4.5-high"], "off").series[0]).toEqual({
      id: "anthropic/claude-sonnet-4.5",
      slug: "anthropic/claude-sonnet-4.5",
      reasoning: "off",
    });
    expect(selectSeries(["custom/model"], "high").series[0]).toEqual({
      id: "custom/model [reasoning=high]",
      slug: "custom/model",
      reasoning: "high",
    });
  });

  it("reports unknown aliases and malformed model IDs before execution", () => {
    const selection = selectSeries([
      "claude-haiku-4.5",
      "typo",
      "vendor/",
      "/model",
      "vendor/model with spaces",
    ]);
    expect(selection.series).toHaveLength(1);
    expect(selection.unknown).toEqual(["typo", "vendor/", "/model", "vendor/model with spaces"]);
  });
});
