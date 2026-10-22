import { describe, expect, test } from "bun:test";
import { modelName, modelSource, modelTitle } from "./model-names.ts";

describe("modelName", () => {
  test("names each Claude family", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-4-5")).toBe("Sonnet 4.5");
    expect(modelName("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelName("claude-fable-5")).toBe("Fable 5");
  });

  test("names each OpenAI Codex family", () => {
    expect(modelName("gpt-5.5")).toBe("GPT-5.5");
    expect(modelName("gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(modelName("gpt-5.3-codex-spark")).toBe("GPT-5.3 Codex Spark");
    expect(modelName("gpt-5.4-mini")).toBe("GPT-5.4 mini");
    expect(modelName("gpt-6-sol")).toBe("GPT-6 Sol");
  });

  test("a dated snapshot takes the name of its id without the date", () => {
    expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelName("claude-opus-4-20250514")).toBe("Opus 4");
  });

  test("an id the table lacks reads as itself", () => {
    expect(modelName("qwen3")).toBe("qwen3");
    expect(modelName("claude-sonnet-9-9-20990101")).toBe("claude-sonnet-9-9-20990101");
  });
});

test("a named model keeps its id beside its provider", () => {
  expect(modelSource({ provider: "anthropic", id: "claude-opus-5-5" })).toBe("anthropic/claude-opus-5-5");
  expect(modelSource({ provider: "ollama", id: "qwen3" })).toBe("ollama");
  expect(modelTitle({ provider: "anthropic", id: "claude-opus-5-5" })).toBe(
    "Opus 5.5 · anthropic/claude-opus-5-5",
  );
  expect(modelTitle({ provider: "ollama", id: "qwen3" })).toBe("ollama/qwen3");
});
