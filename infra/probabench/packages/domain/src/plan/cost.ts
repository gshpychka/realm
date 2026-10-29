import * as Schema from "effect/Schema";

const CostRange = Schema.Struct({ low: Schema.Number, high: Schema.Number });

export const CostEstimate = Schema.Struct({
  requests: Schema.Int,
  cost: Schema.NullOr(CostRange),
  models: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      requests: Schema.Int,
      outputTokenLimit: Schema.Int,
      cost: Schema.NullOr(CostRange),
    }),
  ),
  warning: Schema.NullOr(Schema.String),
});
export type CostEstimate = typeof CostEstimate.Type;

export const COST_ASSUMPTIONS =
  "Input tokens are approximated from prompt length (4 characters per token, plus chat overhead). " +
  "The range allows 1 output token through the output limit, including reasoning. " +
  "Actual token use and provider prices may differ. Credit purchase fees and taxes are excluded.";

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const formatCost = (cost: typeof CostRange.Type | null): string => {
  if (cost === null) return "Unavailable";
  // A sub-cent total should not look free, or require fractions of a cent to read.
  if (cost.high > 0 && cost.high < 0.01) return "<$0.01";
  const low = dollars.format(cost.low);
  const high = dollars.format(cost.high);
  return low === high ? low : `${low}–${high}`;
};
