/** Names the operator reads for model ids pi ships for Anthropic and OpenAI Codex, from pi-ai's model registry. */
const NAMES: Readonly<Record<string, string>> = {
  "claude-opus-4": "Opus 4",
  "claude-opus-4-0": "Opus 4",
  "claude-opus-4-1": "Opus 4.1",
  "claude-opus-4-5": "Opus 4.5",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5": "Opus 5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-4": "Sonnet 4",
  "claude-sonnet-4-0": "Sonnet 4",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-fable-5": "Fable 5",
  "claude-fable-5-1": "Fable 5.1",

  "gpt-5.1": "GPT-5.1",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex mini",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-6-sol": "GPT-6 Sol",
};

/** A snapshot's release date, which names the same model as the id without it. */
const DATED = /-\d{8}$/;

/** The model's friendly name, such as "Opus 5.5" for `claude-opus-5-5`; an id the table lacks reads as itself. */
export function modelName(id: string): string {
  return NAMES[id] ?? NAMES[id.replace(DATED, "")] ?? id;
}

const named = (id: string) => modelName(id) !== id;

/** Where a model comes from, as a row beside its name shows it: the provider, and the id when the name hides it. */
export function modelSource(model: { provider: string; id: string }): string {
  return named(model.id) ? `${model.provider}/${model.id}` : model.provider;
}

/** A model as a notice names it: `provider/id`, led by its name when the table has one. */
export function modelTitle(model: { provider: string; id: string }): string {
  const source = `${model.provider}/${model.id}`;
  return named(model.id) ? `${modelName(model.id)} · ${source}` : source;
}
