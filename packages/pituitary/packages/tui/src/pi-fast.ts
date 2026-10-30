import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** A status present while Fast mode serves the selected model. */
export const FAST_STATUS = "pituitary.fast";

const CHOICE = "pituitary.fast";
type Choice = CustomEntry<{ on: boolean }>;
const isChoice = (entry: SessionEntry): entry is Choice =>
  entry.type === "custom" && entry.customType === CHOICE;

/**
 * Fast mode for the ChatGPT subscription: requests ask for the priority service tier, which
 * answers faster and draws on the subscription at a higher rate (https://developers.openai.com/codex/speed).
 * Each conversation records its own choice; a new one starts at standard speed.
 */
export default function fast(pi: ExtensionAPI): void {
  let on = false;
  // Sign in with ChatGPT accepts priority for every model it serves; an API key bills the tier by its own rules.
  const serves = (ctx: ExtensionContext, model = ctx.model) =>
    model?.provider === "openai" && model.api === "openai-responses" && ctx.modelRegistry.isUsingOAuth(model);
  const show = (ctx: ExtensionContext, model = ctx.model) =>
    ctx.ui.setStatus(FAST_STATUS, on && serves(ctx, model) ? "fast" : undefined);

  pi.on("session_start", (_event, ctx) => {
    on = ctx.sessionManager.getBranch().findLast(isChoice)?.data?.on === true;
    show(ctx);
  });
  pi.on("model_select", (event, ctx) => show(ctx, event.model));
  pi.registerCommand("fast", {
    description: "answer faster on ChatGPT models, at a higher usage rate",
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const next = { "": !on, on: true, off: false }[args.trim()];
      if (next === undefined) return ctx.ui.notify("Use /fast, /fast on, or /fast off.", "warning");
      if (next && !serves(ctx))
        return ctx.ui.notify("Fast mode serves OpenAI models through Sign in with ChatGPT.", "warning");
      on = next;
      pi.appendEntry(CHOICE, { on });
      show(ctx);
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    // Requests for another model, such as an extension's own model call, keep their tier.
    if (!on || !serves(ctx) || !isRecord(payload) || payload.model !== ctx.model?.id) return;
    return { ...payload, service_tier: "priority" };
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
