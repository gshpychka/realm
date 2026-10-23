import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { BenchRequest, BridgeRequest, firstIssue } from "./protocol";

const request = {
  model: "openai/example:free",
  trialsPerStep: 10,
  stepPercent: 25,
  concurrency: 5,
};
const problem = (schema: typeof BenchRequest | typeof BridgeRequest, value: unknown) =>
  Either.match(Schema.decodeUnknownEither(schema)(value), {
    onLeft: firstIssue,
    onRight: () => null,
  });

describe("BridgeRequest", () => {
  it.each([
    request,
    { ...request, model: "gpt-5-mini-low" },
    { ...request, model: `vendor/${"a".repeat(193)}` },
    { ...request, reasoning: "xhigh" },
  ])("accepts %j", (value) => {
    expect(problem(BridgeRequest, value)).toBeNull();
  });

  it.each([
    [null, "Expected"],
    [{ ...request, model: "all" }, "Choose one model"],
    [{ ...request, model: "future-model" }, "Choose one model"],
    [{ ...request, model: "vendor/model+variant" }, "Choose one model"],
    [{ ...request, model: "--help" }, "Choose one model"],
    [{ ...request, model: "model; touch /tmp/oops" }, "Choose one model"],
    [{ ...request, model: "a,b" }, "Choose one model"],
    [{ ...request, model: `vendor/${"a".repeat(194)}` }, "at most 200 characters"],
    [{ ...request, trialsPerStep: 0 }, "Samples per target must be a whole number"],
    [{ ...request, trialsPerStep: 1.5 }, "Samples per target must be a whole number"],
    [{ ...request, trialsPerStep: 10_001 }, "from 1 to 10,000"],
    [{ ...request, stepPercent: 101 }, "Target step must be a whole number"],
    [{ ...request, concurrency: 51 }, "Concurrent requests must be a whole number"],
    [{ ...request, reasoning: "secret" }, "reasoning: Expected"],
    [{ model: request.model }, "trialsPerStep: is missing"],
    [{ ...request, trialsPerStep: 10_000, stepPercent: 1 }, "Browser runs support up to 100,000"],
  ])("rejects %j with a readable reason", (value, reason) => {
    expect(problem(BridgeRequest, value)).toContain(reason);
  });
});

describe("BenchRequest", () => {
  it("bounds each field but leaves the sample budget to browser runs", () => {
    expect(problem(BenchRequest, { ...request, trialsPerStep: 10_000, stepPercent: 1 })).toBeNull();
  });
});
