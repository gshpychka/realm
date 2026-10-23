import { describe, expect, it } from "@effect/vitest";
import { MODEL_ALIASES } from "@probabench/domain";
import * as Effect from "effect/Effect";
import { describePlan, resolvePlan } from "./plan";
import { ALL_ALIASES } from "./series";

describe("resolvePlan", () => {
  it.effect("describes every series with its sample count", () =>
    Effect.gen(function* () {
      const plan = yield* resolvePlan({
        models: [ALL_ALIASES],
        reasoning: undefined,
        options: { trialsPerStep: 5, stepPercent: 50, concurrency: 1, maxTokens: 4096 },
        out: "results.json",
      });
      const samples = MODEL_ALIASES.length * 3 * 5;
      const description = describePlan(plan);
      expect(description).toContain(`Models (${MODEL_ALIASES.length}):`);
      expect(description).toContain("  anthropic/claude-sonnet-4.5 · reasoning high");
      expect(description).toContain(`Projected samples: ${samples}`);
    }),
  );
});
