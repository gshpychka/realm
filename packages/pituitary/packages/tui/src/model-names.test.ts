import { expect, test } from "bun:test";
import { modelName, modelSource, modelTitle } from "./model-names.ts";

const named = { provider: "local", id: "fake-1", name: "Fake One" };
const bare = { provider: "ollama", id: "qwen3", name: "qwen3" };

test("a model reads as the name Pi gives it, and as its id without one", () => {
  expect(modelName(named)).toBe("Fake One");
  expect(modelName(bare)).toBe("qwen3");
  expect(modelName({ provider: "ollama", id: "qwen3", name: " " })).toBe("qwen3");
});

test("a named model keeps its id beside its provider", () => {
  expect(modelSource(named)).toBe("local/fake-1");
  expect(modelSource(bare)).toBe("ollama");
  expect(modelTitle(named)).toBe("Fake One · local/fake-1");
  expect(modelTitle(bare)).toBe("ollama/qwen3");
});
