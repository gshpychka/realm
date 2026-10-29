import type { Probability, ReasoningMode } from "@probabench/domain";

export const DEFAULT_MAX_TOKENS = 4096;

export interface TextMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export const samplingMessages = (x: Probability): readonly TextMessage[] => [
  {
    role: "system",
    content:
      "You are a random bit generator. On each call you output exactly one character — the digit 1 or the digit 0 — and nothing else: no words, no punctuation, no explanation.",
  },
  { role: "user", content: `Output 1 with probability ${Math.round(x * 100)}%, otherwise 0.` },
];

// Some OpenAI routes require at least 16 tokens, even for a one-character answer.
export const outputTokenLimit = (reasoning: ReasoningMode, maxTokens: number): number =>
  reasoning === "off" ? 16 : maxTokens;
