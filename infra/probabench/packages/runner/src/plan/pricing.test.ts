import { join } from "node:path";
import * as FileSystem from "@effect/platform/FileSystem";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { costForDaily } from "./cost";
import { planDaily } from "./daily";
import { resolvePlan } from "./plan";
import { loadPrices } from "./pricing";

it.effect(
  "reuses saved prices across edits and invocations, retaining them when refresh fails",
  () => {
    let calls = 0;
    let fail = false;
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            fail
              ? new Response("Offline", { status: 503 })
              : Response.json({
                  data: [
                    { id: "vendor/model", pricing: { prompt: "0.000002", completion: "0.000008" } },
                  ],
                }),
          ),
        );
      }),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = join(directory, "prices.json");
      const first = yield* loadPrices({ path });
      expect(calls).toBe(1);
      fail = true;
      const cached = yield* loadPrices({ path });
      expect(cached).toEqual(first);
      const plan = yield* resolvePlan({
        models: ["vendor/model"],
        reasoning: "off",
        out: "unused",
        options: { stepPercent: 50, trialsPerStep: 2, concurrency: 8, maxTokens: 128 },
      });
      const quote = (trials: number) =>
        costForDaily(
          planDaily(
            { ...plan, options: { ...plan.options, trialsPerStep: trials } },
            { runs: [] },
            "2026-10-30T00:00:00.000Z",
          ),
          cached,
        );
      expect(quote(10).cost?.high).toBeCloseTo((quote(2).cost?.high ?? 0) * 5);
      expect(calls).toBe(1);
      const refreshed = yield* loadPrices({ path, refresh: true });
      expect(calls).toBe(2);
      expect(refreshed.data).toEqual(first.data);
      expect(refreshed.warning).toContain("using saved prices");
      expect(yield* loadPrices({ path })).toEqual(first);
      expect(calls).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.provide(http));
  },
);
