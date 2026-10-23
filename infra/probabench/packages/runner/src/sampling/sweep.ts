// One series' calibration sweep: at each probability on the grid, ask the model
// for trialsPerStep bits and record every reply.
import { randomUUID } from "node:crypto";
import * as LanguageModel from "@effect/ai/LanguageModel";
import type * as Prompt from "@effect/ai/Prompt";
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
import { type ProviderFailure, withProviderRetry } from "./retry";

/** Bounds each provider attempt, response decoding included, so a stalled request cannot hang a run. */
const ATTEMPT_TIMEOUT = "2 minutes";

const SYSTEM_PROMPT =
  "You are a random bit generator. On each call you output exactly one character — the digit 1 or the digit 0 — and nothing else: no words, no punctuation, no explanation.";

const prompt = (x: Probability): Prompt.RawInput => [
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

/**
 * One bit requested at probability x. Never sets temperature, top_p or top_k: the
 * model's native sampling is what is measured. The provided LanguageModel fixes the
 * series' slug and reasoning. An unparseable reply is an Outcome, not an error.
 */
const sampleBit = (
  x: Probability,
): Effect.Effect<Outcome, ProviderFailure, LanguageModel.LanguageModel> =>
  LanguageModel.generateText({ prompt: prompt(x) }).pipe(
    Effect.timeout(ATTEMPT_TIMEOUT),
    withProviderRetry,
    Effect.map((response) => parseOutcome(response.text)),
  );

/** Samples the series' whole grid into a Run, printing a progress line per finished point. */
export const sweep = (
  series: ModelSeries,
  options: SamplingOptions,
): Effect.Effect<Run, ProviderFailure, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const grid = probabilityGrid(options.stepPercent);
    const points = yield* Effect.forEach(grid, (x, index) =>
      Effect.replicateEffect(sampleBit(x), options.trialsPerStep, {
        concurrency: options.concurrency,
      }).pipe(
        Effect.map((outcomes): Point => ({ x, outcomes })),
        Effect.tap((point) =>
          Console.log(
            formatPointProgress({
              model: series.id,
              point,
              completed: index + 1,
              total: grid.length,
            }),
          ),
        ),
      ),
    );
    return {
      id: randomUUID(),
      model: series.id,
      modelSlug: series.slug,
      reasoning: series.reasoning,
      trialsPerStep: options.trialsPerStep,
      stepPercent: options.stepPercent,
      startedAt,
      points,
    };
  });
