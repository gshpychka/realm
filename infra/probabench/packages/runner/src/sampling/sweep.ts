// One model's observations across the probability grid. Targets are interleaved
// through the shared scheduler, and every reply keeps its target and trial index.
import { randomUUID } from "node:crypto";
import {
  formatPointProgress,
  type Outcome,
  type Point,
  type Probability,
  probabilityGrid,
  type Run,
} from "@probabench/domain";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { SamplingOptions } from "../plan/plan";
import type { ModelSeries } from "../plan/series";
import { OpenRouterClient, type TextMessage } from "./openrouter";
import { type ProviderFailure, withProviderRetry } from "./retry";
import { RequestScheduler } from "./scheduler";

/** Bounds each provider attempt, response decoding included, so a stalled request cannot hang a run. */
const ATTEMPT_TIMEOUT = "2 minutes";

const SYSTEM_PROMPT =
  "You are a random bit generator. On each call you output exactly one character — the digit 1 or the digit 0 — and nothing else: no words, no punctuation, no explanation.";

const prompt = (x: Probability): readonly TextMessage[] => [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: `Output 1 with probability ${Math.round(x * 100)}%, otherwise 0.` },
];

/** Only a trimmed "1" or "0" is a bit; any other reply is kept verbatim. */
const parseOutcome = (reply: string): Outcome => {
  const trimmed = reply.trim();
  if (trimmed === "1") return 1;
  if (trimmed === "0") return 0;
  return { invalidText: reply };
};

/** Samples the series' whole grid into a Run, printing a progress line per finished point. */
export const sweep = (
  series: ModelSeries,
  options: SamplingOptions,
): Effect.Effect<Run, ProviderFailure, OpenRouterClient | RequestScheduler> =>
  Effect.gen(function* () {
    const client = yield* OpenRouterClient;
    const scheduler = yield* RequestScheduler;
    const sampleBit = (x: Probability) =>
      scheduler
        .request(
          series.modelSlug,
          client
            .complete(series, options.maxTokens, prompt(x))
            .pipe(Effect.timeout(ATTEMPT_TIMEOUT)),
        )
        .pipe(withProviderRetry, Effect.map(parseOutcome));
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const grid = probabilityGrid(options.stepPercent);
    const points = grid.map((x) => ({
      x,
      outcomes: Array<Outcome>(options.trialsPerStep),
    })) satisfies Point[];
    const received = grid.map(() => 0);
    let completed = 0;
    // Interleave targets, keeping the original trial order in the saved observations.
    // Workers are bounded independently of the number of samples in the plan.
    function* samples() {
      for (let trial = 0; trial < options.trialsPerStep; trial++) {
        for (let target = 0; target < points.length; target++) yield { trial, target };
      }
    }
    yield* Effect.forEach(
      samples(),
      ({ trial, target }) => {
        const point = points[target];
        if (!point) return Effect.dieMessage("Missing sampling target");
        return sampleBit(point.x).pipe(
          Effect.flatMap((outcome) => {
            point.outcomes[trial] = outcome;
            received[target] = (received[target] ?? 0) + 1;
            if (received[target] !== options.trialsPerStep) return Effect.void;
            completed++;
            return Console.log(
              formatPointProgress({ model: series.model, point, completed, total: grid.length }),
            );
          }),
        );
      },
      { concurrency: options.concurrency, discard: true },
    );
    return {
      id: randomUUID(),
      ...series,
      trialsPerStep: options.trialsPerStep,
      stepPercent: options.stepPercent,
      startedAt,
      points,
    };
  });
