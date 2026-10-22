import { type Glyph, glyphs } from "./glyphs.ts";
import { brand } from "./theme.ts";

/** A provider's icon as drawn, and its colour; a `null` colour takes that of the text beside it. */
export interface ProviderMark {
  glyph: string;
  colour: string | null;
}

/** Providers by pi's provider id, each with the mark of the company whose models it serves. */
const MARKS: readonly [RegExp, Glyph, string | null][] = [
  [/^(anthropic|claude-bridge)$/, "anthropic", brand.anthropic],
  [/^(azure-)?openai(-|$)/, "openai", brand.openai],
  [/^google(-|$)/, "google", brand.google],
  [/^github-copilot$/, "copilot", null],
];

/**
 * The mark for a model's provider, from pi's provider id; a provider Nerd Fonts has no mark for,
 * such as ollama, takes the generic one.
 */
export function providerMark(provider: string): ProviderMark {
  const [, glyph, colour] = MARKS.find(([id]) => id.test(provider)) ?? [null, "model", null];
  return { glyph: glyphs[glyph], colour };
}
