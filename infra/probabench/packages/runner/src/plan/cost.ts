import type { CostEstimate } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { outputTokenLimit, samplingMessages } from "../sampling/request";
import type { DailyPlan } from "./daily";
import { loadPrices, type Prices } from "./pricing";

const Price = Schema.NumberFromString.pipe(Schema.finite(), Schema.nonNegative());
const Pricing = Schema.Struct({
  prompt: Price,
  completion: Price,
  request: Schema.optionalWith(Price, { default: () => 0 }),
});
const decodePricing = Schema.decodeUnknownOption(Pricing);

/** Recalculate from a price snapshot without I/O. */
export const costForDaily = (daily: DailyPlan, catalog: Prices): CostEstimate => {
  const prices = new Map(catalog.data.map((model) => [model.id, model.pricing]));
  const models = daily.series
    .filter((entry) => entry.remaining > 0)
    .map(({ series, options, points, remaining }) => {
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
    warning:
      catalog.warning ??
      (cost === null
        ? "OpenRouter has no usable price for some selected models; no total is available."
        : null),
  } satisfies CostEstimate;
};

export const estimateCost = (daily: DailyPlan) =>
  daily.remaining === 0
    ? Effect.succeed({
        requests: 0,
        cost: { low: 0, high: 0 },
        models: [],
        warning: null,
      } satisfies CostEstimate)
    : Effect.map(loadPrices(), (prices) => costForDaily(daily, prices));
