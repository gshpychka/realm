import * as LanguageModel from "@effect/ai/LanguageModel";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSeries } from "../plan/series";
import { openrouterClientLayer, openrouterModelLayer } from "./openrouter";
import { chatEndpoint, withApiKey } from "./testing";

/** Request fields that would override the model's native sampling. */
const SAMPLING_OVERRIDES = ["temperature", "top_p", "top_k", "reasoning_effort"] as const;

describe("openrouterModelLayer", () => {
  it.effect.each<{ readonly series: ModelSeries; readonly expected: object }>([
    {
      series: { model: "vendor/plain", modelSlug: "vendor/plain", reasoning: "off" },
      expected: { max_tokens: 16, reasoning: { enabled: false } },
    },
    {
      series: {
        model: "vendor/thinker [reasoning=high]",
        modelSlug: "vendor/thinker",
        reasoning: "high",
      },
      expected: { max_tokens: 4096, reasoning: { effort: "high" } },
    },
  ])(
    "sends $series.model with its reasoning, output ceiling and the key",
    ({ series, expected }) => {
      const endpoint = chatEndpoint();
      return Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({ prompt: "Emit a bit" });
        expect(response.text).toBe("1");
        expect(endpoint.requests).toHaveLength(1);
        const [request] = endpoint.requests;
        expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(request?.headers.authorization).toBe("Bearer sk-test");
        expect(request?.body).toMatchObject({ model: series.modelSlug, ...expected });
        for (const field of SAMPLING_OVERRIDES) expect(request?.body[field]).toBeUndefined();
      }).pipe(
        Effect.provide(
          openrouterModelLayer(series, 4096).pipe(
            Layer.provide(openrouterClientLayer),
            Layer.provide(endpoint.layer),
          ),
        ),
        withApiKey("sk-test"),
      );
    },
  );
});
