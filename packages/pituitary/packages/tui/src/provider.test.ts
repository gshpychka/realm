import { expect, test } from "bun:test";
import { type Glyph, glyphs } from "./glyphs.ts";
import { providerMark } from "./provider.ts";

test.each<[string, Glyph, string | null]>([
  ["anthropic", "anthropic", "#d97757"],
  ["claude-bridge", "anthropic", "#d97757"],
  ["openai", "openai", "#10a37f"],
  ["openai-codex", "openai", "#10a37f"],
  ["azure-openai-responses", "openai", "#10a37f"],
  ["google", "google", "#4285f4"],
  ["google-vertex", "google", "#4285f4"],
  ["google-gemini-cli", "google", "#4285f4"],
  ["github-copilot", "copilot", null],
  ["ollama", "model", null],
  ["openrouter", "model", null],
  ["fake", "model", null],
  ["", "model", null],
])("%s takes the %s icon in %s", (provider, glyph, colour) => {
  expect(providerMark(provider)).toEqual({ glyph: glyphs[glyph], colour });
});
