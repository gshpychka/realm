import * as LanguageModel from "@effect/ai/LanguageModel";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { openrouterClientLayer, openrouterModelLayer } from "./openrouter";
import type { BenchTarget } from "./registry";
import { chatEndpoint } from "./test-fixtures";

/** Request fields that would override the model's native sampling. */
const SAMPLING_OVERRIDES = ["temperature", "top_p", "top_k", "reasoning_effort"] as const;

describe("openrouterModelLayer", () => {
  const cases: ReadonlyArray<readonly [BenchTarget, Record<string, unknown>]> = [
    [
      { id: "anthropic/claude-haiku-4.5", slug: "anthropic/claude-haiku-4.5", reasoning: "off" },
      { max_tokens: 16, reasoning: { enabled: false } },
    ],
    [
      {
        id: "anthropic/claude-sonnet-4.5 [reasoning=high]",
        slug: "anthropic/claude-sonnet-4.5",
        reasoning: "high",
      },
      { max_tokens: 4096, reasoning: { effort: "high" } },
    ],
  ];
  for (const [target, expected] of cases) {
    it.effect(`sends ${target.id} with its reasoning, output ceiling and the key`, () => {
      const endpoint = chatEndpoint();
      return Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({ prompt: "Emit a bit" });
        expect(response.text).toBe("1");
        expect(endpoint.requests).toHaveLength(1);
        const [request] = endpoint.requests;
        expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(request?.headers.authorization).toBe("Bearer sk-test");
        expect(request?.body).toMatchObject({ model: target.slug, ...expected });
        for (const field of SAMPLING_OVERRIDES) expect(request?.body[field]).toBeUndefined();
      }).pipe(
        Effect.provide(
          openrouterModelLayer(target, 4096).pipe(
            Layer.provide(openrouterClientLayer),
            Layer.provide(endpoint.layer),
          ),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["OPENROUTER_API_KEY", "sk-test"]])),
        ),
      );
    });
  }
});
