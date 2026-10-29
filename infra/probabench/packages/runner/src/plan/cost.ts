import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import type { CostEstimate } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { outputTokenLimit, samplingMessages } from "../sampling/request";
import type { DailyPlan } from "./daily";
import type { SamplingOptions } from "./plan";

const Catalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, pricing: Schema.Unknown })),
});
const Price = Schema.NumberFromString.pipe(Schema.finite(), Schema.nonNegative());
const Pricing = Schema.Struct({
  prompt: Price,
  completion: Price,
  request: Schema.optionalWith(Price, { default: () => 0 }),
});
const decodePricing = Schema.decodeUnknownOption(Pricing);

/** Public metadata only: never sends a completion, reads a key, or writes history. */
export const estimateCost = (daily: DailyPlan, options: SamplingOptions) =>
  Effect.gen(function* () {
    if (daily.remaining === 0)
      return {
        requests: 0,
        cost: { low: 0, high: 0 },
        models: [],
        warning: null,
      } satisfies CostEstimate;

    const catalog = yield* HttpClient.get("https://openrouter.ai/api/v1/models").pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Catalog)),
      Effect.timeout("8 seconds"),
      Effect.option,
    );
    const prices = new Map(
      Option.isSome(catalog) ? catalog.value.data.map((m) => [m.id, m.pricing]) : [],
    );
    const models = daily.series
      .filter((entry) => entry.remaining > 0)
      .map(({ series, points, remaining }) => {
        const limit = outputTokenLimit(series.reasoning, options.maxTokens);
        const pricing = decodePricing(prices.get(series.modelSlug));
        let cost: CostEstimate["cost"] = null;
        if (Option.isSome(pricing)) {
          const rate = pricing.value;
          const inputTokens = points.reduce((sum, point) => {
            const missing = Math.max(0, options.trialsPerStep - point.outcomes.length);
            // Chat templates and tokenizers vary by provider. This is an explicit
            // approximation of the actual prompt, not an invented average bill.
            const tokens =
              2 +
              samplingMessages(point.x).reduce(
                (count, message) => count + Math.ceil(message.content.length / 4) + 4,
                0,
              );
            return sum + missing * tokens;
          }, 0);
          const base = inputTokens * rate.prompt + remaining * rate.request;
          cost = {
            low: base + remaining * rate.completion,
            high: base + remaining * limit * rate.completion,
          };
        }
        return { model: series.model, requests: remaining, outputTokenLimit: limit, cost };
      });
    const cost = models.every((model) => model.cost !== null)
      ? models.reduce(
          (total, model) => ({
            low: total.low + (model.cost?.low ?? 0),
            high: total.high + (model.cost?.high ?? 0),
          }),
          { low: 0, high: 0 },
        )
      : null;
    return {
      requests: daily.remaining,
      cost,
      models,
      warning: Option.isNone(catalog)
        ? "Could not fetch OpenRouter prices."
        : cost === null
          ? "OpenRouter has no usable price for some selected models; no total is available."
          : null,
    } satisfies CostEstimate;
  });
