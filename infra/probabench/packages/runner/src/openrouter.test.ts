import * as LanguageModel from "@effect/ai/LanguageModel";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { openrouterClientLayer, openrouterModelLayer, toOpenRouterConfig } from "./openrouter";
import type { BenchTarget } from "./registry";
import { chatEndpoint } from "./test-fixtures";

const withKey = (key: string) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["OPENROUTER_API_KEY", key]])));

const SAMPLING_AND_FOOTGUN_KNOBS = ["temperature", "top_p", "top_k", "reasoning_effort"] as const;

const noReasoning: BenchTarget = {
  id: "m",
  slug: "anthropic/claude-haiku-4.5",
  reasoning: "off",
};
const effortTarget: BenchTarget = {
  id: "m-high",
  slug: "anthropic/claude-sonnet-4.5",
  reasoning: "high",
};

describe("toOpenRouterConfig", () => {
  it("explicitly disables reasoning on a non-reasoning target", () => {
    const config = toOpenRouterConfig(noReasoning, 4096);
    expect(config.max_tokens).toBe(16);
    expect(config.reasoning).toEqual({ enabled: false });
  });

  it("threads the effort onto reasoning.effort and keeps the max_tokens ceiling", () => {
    const config = toOpenRouterConfig(effortTarget, 4096);
    expect(config.max_tokens).toBe(4096);
    expect(config.reasoning).toEqual({ effort: "high" });
  });

  it("never carries a sampling knob or a top-level reasoning_effort", () => {
    for (const target of [noReasoning, effortTarget]) {
      const config = toOpenRouterConfig(target, 4096) as Record<string, unknown>;
      for (const knob of SAMPLING_AND_FOOTGUN_KNOBS) {
        expect(config[knob]).toBeUndefined();
      }
    }
  });
});

describe("openrouterClientLayer", () => {
  const acquireClient = Effect.gen(function* () {
    yield* LanguageModel.LanguageModel;
  });

  it.effect("fails with a config error when OPENROUTER_API_KEY is unset", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        acquireClient.pipe(
          Effect.provide(
            openrouterModelLayer(noReasoning, 4096).pipe(
              Layer.provide(openrouterClientLayer),
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
          Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map()))),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("builds the client when OPENROUTER_API_KEY is provided", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        acquireClient.pipe(
          Effect.provide(
            openrouterModelLayer(noReasoning, 4096).pipe(
              Layer.provide(openrouterClientLayer),
              Layer.provide(FetchHttpClient.layer),
            ),
          ),
          Effect.provide(withKey("sk-test")),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});

describe("openrouterModelLayer", () => {
  for (const [target, expectedReasoning] of [
    [noReasoning, { enabled: false }],
    [effortTarget, { effort: "high" }],
  ] as const) {
    it.effect(
      `preserves ${JSON.stringify(expectedReasoning)} on the wire without sampling overrides`,
      () => {
        const endpoint = chatEndpoint();
        return Effect.gen(function* () {
          const response = yield* LanguageModel.generateText({ prompt: "Emit a bit" });
          expect(response.text).toBe("1");
          expect(endpoint.requests).toHaveLength(1);
          const request = endpoint.requests[0];
          if (request === undefined) throw new Error("Expected a provider request");
          expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
          expect(request.body.reasoning).toEqual(expectedReasoning);
          for (const knob of SAMPLING_AND_FOOTGUN_KNOBS) expect(request.body[knob]).toBeUndefined();
        }).pipe(
          Effect.provide(
            openrouterModelLayer(target, 4096).pipe(
              Layer.provide(openrouterClientLayer),
              Layer.provide(endpoint.layer),
            ),
          ),
          Effect.provide(withKey("sk-test")),
        );
      },
    );
  }

  it.effect("builds a LanguageModel layer for a target", () =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;
      expect(model.generateText).toBeDefined();
    }).pipe(
      Effect.provide(
        openrouterModelLayer(effortTarget, 4096).pipe(
          Layer.provide(openrouterClientLayer),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Effect.provide(withKey("sk-test")),
    ),
  );
});
