import type { ConversationLink } from "@pituitary/session";
import type { PickerSpec } from "../components/picker.tsx";
import { modelName, modelSource, modelTitle } from "../model-names.ts";
import { providerMark } from "../provider.ts";
import type { SessionController } from "../use-session.ts";
export interface CommandContext {
  link: ConversationLink;
  session: SessionController;
  pick(spec: PickerSpec): void;
  copy(text: string): boolean;
  quit(): void;
  hotkeys(): string;
}
export async function runCommand(name: string, args: string, context: CommandContext): Promise<void> {
  try {
    await run(name, args, context);
  } catch (error) {
    context.session.notify("error", `/${name}: ${String(error instanceof Error ? error.message : error)}`);
  }
}
async function run(name: string, args: string, { link, session, ...context }: CommandContext): Promise<void> {
  const state = session.state;
  switch (name) {
    case "model": {
      const { models } = await link.call({ type: "get_available_models" });
      if (!models.length)
        throw new Error(
          "No configured models are available. In regular Pi, use /login to connect a provider; Dura uses the host's declared provider grants.",
        );
      const choose = async (value: string) => {
        const [provider = "", ...rest] = value.split("/");
        const model = await link.call({ type: "set_model", provider, modelId: rest.join("/") });
        await session.refresh();
        session.notify("info", `model: ${modelTitle(model)}`);
      };
      const exact = args
        ? models.find((model) => `${model.provider}/${model.id}` === args || model.id === args)
        : undefined;
      if (exact) {
        await choose(`${exact.provider}/${exact.id}`);
        return;
      }
      context.pick({
        title: "model",
        items: models.map((model) => ({
          label: modelName(model.id),
          detail: modelSource(model),
          icon: providerMark(model.provider),
          value: `${model.provider}/${model.id}`,
          current: model.id === state?.model?.id && model.provider === state?.model?.provider,
        })),
        ...(args ? { query: args } : {}),
        onPick: (value) => void choose(value).catch((error) => session.notify("error", String(error))),
      });
      return;
    }
    case "thinking": {
      const { levels } = await link.call({ type: "get_available_thinking_levels" });
      const choose = async (value: string) => {
        const level = levels.find((item) => item === value);
        if (!level) throw new Error(`Available thinking levels: ${levels.join(", ")}`);
        await link.call({ type: "set_thinking_level", level });
        await session.refresh();
      };
      if (args) {
        await choose(args);
        return;
      }
      context.pick({
        title: "thinking level",
        items: levels.map((level) => ({
          label: level,
          value: level,
          current: level === state?.thinkingLevel,
        })),
        onPick: (value) => void choose(value).catch((error) => session.notify("error", String(error))),
      });
      return;
    }
    case "compact":
      await link.call({ type: "compact", ...(args ? { customInstructions: args } : {}) });
      session.notify("info", "Compaction started.");
      return;
    case "name":
      if (!args) {
        session.notify(
          "info",
          state?.sessionName
            ? `This conversation is named ${state.sessionName}`
            : "Use /name <name> to name this conversation.",
        );
        return;
      }
      await link.call({ type: "set_session_name", name: args });
      await session.refresh();
      return;
    case "session": {
      const stats = await link.getSessionStats();
      const t = stats.tokens;
      const count = (n: number) => n.toLocaleString("en");
      session.notify(
        "info",
        [
          `conversation ${stats.sessionId}`,
          "messages " +
            stats.userMessages +
            " from you · " +
            stats.assistantMessages +
            " replies · " +
            stats.toolCalls +
            " tool calls",
          "tokens: input " +
            count(t.input) +
            " · output " +
            count(t.output) +
            " · cache read " +
            count(t.cacheRead) +
            " · cache written " +
            count(t.cacheWrite),
          `cost $${stats.cost.toFixed(4)}`,
        ].join("\n"),
      );
      return;
    }
    case "copy": {
      const { text } = await link.call({ type: "get_last_assistant_text" });
      if (!text) throw new Error("There is no reply to copy yet");
      if (!context.copy(text)) throw new Error("The terminal refused the clipboard write");
      session.notify("info", "Copied the last reply.");
      return;
    }
    case "hotkeys":
      session.notify("info", context.hotkeys());
      return;
    case "quit":
      context.quit();
      return;
    default:
      throw new Error("Unknown command");
  }
}
