import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentLink } from "@pituitary/rpc";
import type { Checked } from "../checklist.ts";
import { resolveAgentCommand } from "../config.ts";
import { modelName, modelSource } from "../model-names.ts";
import { counted } from "../plural.ts";
import { providerMark } from "../provider.ts";
import { restartToApply } from "./carry-over.ts";
import type { CommandContext } from "./run-command.ts";
import { projectTrusted } from "./trust.ts";

async function availableModels(link: AgentLink) {
  const { models } = await link.call({ type: "get_available_models" });
  return models;
}

type Model = Awaited<ReturnType<typeof availableModels>>[number];

async function settings() {
  const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const cwd = process.cwd();
  return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: await projectTrusted(cwd) });
}

/**
 * The `provider/id` of each model pi's settings enable, in their order, as pi resolves the
 * patterns there; a pattern that matches no model stays as written. `null` when none are set.
 */
export async function enabledModels(models: readonly Model[]): Promise<string[] | null> {
  const store = await settings();
  const patterns = store.getEnabledModels();
  if (!patterns?.length) return null;
  const { resolveModelScopeWithDiagnostics } = await import("@earendil-works/pi-coding-agent");
  // SAFETY: the resolver asks its runtime only for the available models, which this one answers.
  const runtime = { getAvailable: async () => models } as unknown as ModelRuntime;
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, runtime);
  const ids = scopedModels.map(({ model }) => `${model.provider}/${model.id}`);
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
  }
  return ids;
}

/** Chooses the models ctrl+p cycles, saves them to pi's settings, and restarts pi to take them up. */
export async function scopedModels(context: CommandContext): Promise<void> {
  const models = await availableModels(context.link);
  if (models.length === 0) throw new Error("no models are available; sign in with `pi` first");
  const save = async (checked: Checked) => {
    const store = await settings();
    // An empty scope cycles every model, as a missing one does.
    store.setEnabledModels(checked?.length ? [...checked] : undefined);
    await store.flush();
    const [failed] = store.drainErrors();
    if (failed) throw failed.error;
    if (resolveAgentCommand().args.includes("--models")) {
      context.session.notify(
        "warning",
        "--models on the command line decides what ctrl+p cycles while pituitary runs",
      );
    }
    restartToApply(
      context,
      checked?.length
        ? `saved ${counted(checked.length, "model")} for ctrl+p to cycle`
        : "saved every model for ctrl+p to cycle",
    );
  };
  context.pickMany({
    title: "scoped models",
    note: "the models ctrl+p cycles, in order",
    groupName: "provider",
    items: models.map((model) => ({
      label: modelName(model.id),
      detail: modelSource(model),
      icon: providerMark(model.provider),
      value: `${model.provider}/${model.id}`,
      group: model.provider,
    })),
    checked: await enabledModels(models),
    onSave: (checked) => void saveOrSay(checked),
  });

  /** Saves the choice, or says in the conversation why it could not. */
  async function saveOrSay(checked: Checked): Promise<void> {
    try {
      await save(checked);
    } catch (cause) {
      context.session.notify(
        "error",
        `/scoped-models: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
}
