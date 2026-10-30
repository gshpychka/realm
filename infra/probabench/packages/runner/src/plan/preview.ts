// Node entry for the dev server's read-only quote. Use the same plan, history,
// prompt, output limits and pricing as the CLI.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import type { benchArgs } from "@probabench/domain";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_MAX_TOKENS } from "../sampling/request";
import { CloudHistory, cloudHistoryLayer } from "../store/cloud-history";
import { HISTORY_PATH, readSharedHistory } from "../store/results-store";
import { estimateCost } from "./cost";
import { planDaily } from "./daily";
import { resolvePlan } from "./plan";
import { splitModels } from "./series";

/** Proxy the shared history through the local development server. */
export const previewHistory = (after: number) =>
  Effect.flatMap(CloudHistory, (cloud) => cloud.page(after)).pipe(
    Effect.provide(cloudHistoryLayer),
    Effect.provide(NodeHttpClient.layer),
  );

export const previewCost = (request: Parameters<typeof benchArgs>[0]) =>
  Effect.gen(function* () {
    const plan = yield* resolvePlan({
      models: splitModels(request.model),
      reasoning: request.reasoning,
      options: { ...request, maxTokens: DEFAULT_MAX_TOKENS },
      out: HISTORY_PATH,
    });
    const daily = planDaily(
      plan,
      yield* readSharedHistory(plan.out),
      new Date(yield* Clock.currentTimeMillis).toISOString(),
    );
    return yield* estimateCost(daily);
  }).pipe(
    Effect.provide(cloudHistoryLayer),
    Effect.provide(Layer.merge(NodeFileSystem.layer, NodeHttpClient.layer)),
  );
