// One target's calibration sweep: at each probability on the grid, ask the model
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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { SamplingOptions } from "./plan";
import type { BenchTarget } from "./registry";
import { type ProviderFailure, withProviderRetry } from "./retry";

/** A sample whose request failed for good. An unparseable reply is an Outcome, not an error. */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly cause: ProviderFailure;
}> {}

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
 * target's slug and reasoning.
 */
const sampleBit = (x: Probability): Effect.Effect<Outcome, LlmError, LanguageModel.LanguageModel> =>
  LanguageModel.generateText({ prompt: prompt(x) }).pipe(
    Effect.timeout(ATTEMPT_TIMEOUT),
    withProviderRetry,
    Effect.map((response) => parseOutcome(response.text)),
    Effect.mapError((cause) => new LlmError({ cause })),
  );

/** Samples the target's whole grid into a Run, printing a progress line per finished point. */
export const sweep = (
  target: BenchTarget,
  options: SamplingOptions,
): Effect.Effect<Run, LlmError, LanguageModel.LanguageModel> =>
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
              model: target.id,
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
      model: target.id,
      modelSlug: target.slug,
      reasoning: target.reasoning,
      trialsPerStep: options.trialsPerStep,
      stepPercent: options.stepPercent,
      startedAt,
      points,
    };
  });
