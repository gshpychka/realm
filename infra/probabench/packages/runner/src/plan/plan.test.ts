import { describe, expect, it } from "@effect/vitest";
import { MAX_RETRIES, MODEL_ALIASES } from "@probabench/domain";
import * as Effect from "effect/Effect";
import { describePlan, resolvePlan } from "./plan";
import { ALL_ALIASES } from "./targets";

describe("resolvePlan", () => {
  it.effect("describes every target with its samples and retry ceiling", () =>
    Effect.gen(function* () {
      const plan = yield* resolvePlan({
        models: [ALL_ALIASES],
        reasoning: undefined,
        options: { trialsPerStep: 5, stepPercent: 50, concurrency: 1, maxTokens: 4096 },
        out: "results.json",
      });
      const samples = MODEL_ALIASES.length * 3 * 5;
      const description = describePlan(plan);
      expect(description).toContain(`Targets (${MODEL_ALIASES.length}):`);
      expect(description).toContain(
        "  anthropic/claude-sonnet-4.5 [reasoning=high] · reasoning high",
      );
      expect(description).toContain(`Projected samples: ${samples}`);
      expect(description).toContain(
        `Provider attempts with retries: up to ${samples * (MAX_RETRIES + 1)}`,
      );
    }),
  );
});
