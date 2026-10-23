import { describe, expect, it } from "@effect/vitest";
import { MODEL_ALIASES } from "@probabench/domain";
import { ALL_ALIASES, describeAliases, selectSeries, splitModels } from "./series";

// MODEL_ALIASES is a starter list that changes as models age; tests pick aliases by role.
const plain = MODEL_ALIASES.find((model) => model.reasoning === undefined);
const reasoned = MODEL_ALIASES.find((model) => model.reasoning !== undefined);
if (plain === undefined || reasoned === undefined) {
  throw new Error("MODEL_ALIASES needs an alias without reasoning and one with it");
}

describe("OpenRouter model selection", () => {
  it("lists aliases with their canonical slugs", () => {
    expect(describeAliases()).toContain(`${plain.alias} → ${plain.slug}`);
  });

  it("splits a comma-separated model list into trimmed tokens", () => {
    expect(splitModels(" vendor/model , ,all,")).toEqual(["vendor/model", "all"]);
  });

  it("expands all to every alias, keeping reasoning variants apart", () => {
    const selection = selectSeries([ALL_ALIASES]);
    expect(selection.series).toHaveLength(MODEL_ALIASES.length);
    expect(selection.unknown).toEqual([]);
  });

  it("accepts arbitrary OpenRouter slugs and preserves request order", () => {
    const selection = selectSeries(["custom-vendor/new-model:free", plain.alias]);
    expect(selection.series.map((entry) => entry.model)).toEqual([
      "custom-vendor/new-model:free",
      plain.slug,
    ]);
    expect(selection.unknown).toEqual([]);
  });

  it("dedupes aliases and model IDs resolving to the same series", () => {
    expect(selectSeries([plain.alias, plain.slug]).series).toHaveLength(1);
    expect(selectSeries([ALL_ALIASES, reasoned.alias]).series).toEqual(
      selectSeries([ALL_ALIASES]).series,
    );
  });

  it("defaults slug reasoning off and preserves a named alias mode", () => {
    expect(selectSeries([reasoned.slug]).series[0]?.reasoning).toBe("off");
    expect(selectSeries([reasoned.alias]).series[0]?.reasoning).toBe(reasoned.reasoning);
  });

  it("can override aliases or slugs with an explicit reasoning mode", () => {
    expect(selectSeries([reasoned.alias], "off").series[0]).toEqual({
      model: reasoned.slug,
      modelSlug: reasoned.slug,
      reasoning: "off",
    });
    expect(selectSeries(["custom/model"], "high").series[0]).toEqual({
      model: "custom/model [reasoning=high]",
      modelSlug: "custom/model",
      reasoning: "high",
    });
  });

  it("reports unknown aliases and malformed model IDs before execution", () => {
    const selection = selectSeries([
      plain.alias,
      "typo",
      "vendor/",
      "/model",
      "vendor/model with spaces",
    ]);
    expect(selection.series).toHaveLength(1);
    expect(selection.unknown).toEqual(["typo", "vendor/", "/model", "vendor/model with spaces"]);
  });
});
