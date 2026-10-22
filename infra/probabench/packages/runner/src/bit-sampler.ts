// BitSampler turns a single calibration sample into a Trial: it prompts the
// language model to emit one bit at probability x and strict-parses the reply.
// It stays model-agnostic — `sampleBit` requires a LanguageModel from context,
// so the caller provides the target-specific layer (slug + baked reasoning).
import type * as AiError from "@effect/ai/AiError";
import * as LanguageModel from "@effect/ai/LanguageModel";
import type * as Prompt from "@effect/ai/Prompt";
import type { Probability, Trial } from "@probabench/domain";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** A transport or provider failure while sampling. Invalid content is a Trial, never an error. */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly cause: AiError.AiError | Cause.TimeoutException;
}> {}

/** Bound each provider attempt, including response decoding, to avoid stalled runs. */
export const SAMPLE_TIMEOUT = "2 minutes";

/** Instructs the model to behave as a bare bit generator emitting a single digit. */
export const SYSTEM_PROMPT =
  "You are a random bit generator. On each call you output exactly one character — the digit 1 or the digit 0 — and nothing else: no words, no punctuation, no explanation.";

/** The system + user messages that request one bit at the target probability x. */
const buildPrompt = (x: Probability): Prompt.RawInput => [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "user", content: `Output 1 with probability ${Math.round(x * 100)}%, otherwise 0.` },
];

/**
 * Strict-parses a model reply into a Trial: the trimmed text `"1"`→1, `"0"`→0;
 * anything else is an invalid Trial that captures the raw (untrimmed) reply.
 */
export const parseTrial = (raw: string): Trial => {
  const trimmed = raw.trim();
  if (trimmed === "1") return 1;
  if (trimmed === "0") return 0;
  return { invalidText: raw };
};

/**
 * Samples one bit at probability x. The target's slug and baked reasoning config
 * live in the LanguageModel layer the caller provides around each sweep.
 * Never sends temperature/top_p/top_k — native-default sampling is the measurement.
 */
export class BitSampler extends Effect.Service<BitSampler>()("BitSampler", {
  sync: () => ({
    sampleBit: (x: Probability): Effect.Effect<Trial, LlmError, LanguageModel.LanguageModel> =>
      LanguageModel.generateText({ prompt: buildPrompt(x) }).pipe(
        Effect.timeout(SAMPLE_TIMEOUT),
        Effect.map((response) => parseTrial(response.text)),
        Effect.mapError((cause) => new LlmError({ cause })),
        Effect.withSpan("BitSampler.sampleBit", { attributes: { x } }),
      ),
  }),
}) {}
