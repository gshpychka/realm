import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageMonitor } from "./usage/monitor.ts";
import {
  USAGE_STATUS,
  type UsageAuth,
  type UsageProvider,
  type UsageReport,
  type UsageTarget,
} from "./usage/types.ts";

export function usageProvider(provider: string): UsageProvider | undefined {
  if (provider === "openai" || provider === "openai-codex") return "openai";
  if (provider === "anthropic" || provider === "openrouter") return provider;
  return undefined;
}

export function initialUsage(ctx: ExtensionContext, model = ctx.model): UsageReport | undefined {
  const provider = model && usageProvider(model.provider);
  if (!model || !provider) return;
  const auth: UsageAuth =
    provider !== "openrouter" && ctx.modelRegistry.isUsingOAuth(model) ? "subscription" : "api";
  return { provider, auth, model: model.id, state: "loading", metrics: [], notes: [] };
}

/** Pi resolves and refreshes credentials; only official provider hosts receive usage requests. */
export async function resolveUsage(
  ctx: ExtensionContext,
  model = ctx.model,
): Promise<UsageTarget | UsageReport | undefined> {
  const report = initialUsage(ctx, model);
  if (!report || !model) return;
  const unavailable = (note: string): UsageReport => ({ ...report, state: "unavailable", notes: [note] });
  // Sign in with ChatGPT's direct-token scope has no usage-read capability: https://github.com/openai/codex/issues/54219.
  if (model.provider === "openai" && report.auth === "subscription")
    return unavailable(
      "Sign in with ChatGPT does not expose plan usage to this app. Check ChatGPT's usage page.",
    );
  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return unavailable("Pi could not resolve credentials. Use /login to reconnect.");
  let endpoint: URL;
  try {
    endpoint = new URL(resolved.baseUrl ?? model.baseUrl);
  } catch {
    return unavailable("Usage is unavailable for this provider endpoint.");
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(resolved.headers ?? {}))
    if (typeof value === "string") headers.set(key, value);
  const token =
    (report.provider === "anthropic" ? headers.get("x-api-key") : undefined) ??
    headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ??
    resolved.apiKey;
  if (!token) return unavailable("No provider credential is available. Use /login to connect.");
  // Anthropic's transport also accepts subscription tokens through API-key configuration.
  let auth = report.auth;
  if (report.provider === "anthropic") auth = token.includes("sk-ant-oat") ? "subscription" : "api";
  const hosts = {
    openai: ["api.openai.com", "chatgpt.com"],
    anthropic: ["api.anthropic.com"],
    openrouter: ["openrouter.ai"],
  } satisfies Record<UsageProvider, string[]>;
  const pollsAccount = auth === "subscription" || report.provider === "openrouter";
  if (
    pollsAccount &&
    (endpoint.protocol !== "https:" || endpoint.port || !hosts[report.provider].includes(endpoint.hostname))
  )
    return { ...unavailable("Account usage is unavailable for a custom provider endpoint."), auth };
  const accountId = headers.get("chatgpt-account-id") ?? chatGPTAccountId(token);
  return { provider: report.provider, auth, model: model.id, token, accountId };
}

function chatGPTAccountId(token: string): string | undefined {
  if (token.length > 32_768) return;
  try {
    const [, payload] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
    const id: unknown = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && /^[\w-]{1,200}$/.test(id) ? id : undefined;
  } catch {
    return;
  }
}

/** Pituitary loads this collector only for its regular Pi conversations. */
export default function usage(pi: ExtensionAPI): void {
  let monitor: UsageMonitor | undefined;
  let context: ExtensionContext | undefined;
  let model: ExtensionContext["model"];
  let report: UsageReport | undefined;
  let open = false;
  const publish = () =>
    context?.ui.setStatus(USAGE_STATUS, report ? JSON.stringify({ report, open }) : undefined);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    monitor?.dispose();
    context = ctx;
    model = ctx.model;
    open = false;
    monitor = new UsageMonitor({
      resolve: () => resolveUsage(ctx, model),
      publish: (next) => {
        report = next;
        publish();
      },
    });
    monitor.start(initialUsage(ctx, model));
  });
  pi.on("model_select", (event, ctx) => {
    if (!monitor) return;
    context = ctx;
    model = event.model;
    monitor.select(initialUsage(ctx, model));
  });
  pi.on("after_provider_response", (event) => monitor?.observe(event.headers));
  pi.on("agent_settled", () => void monitor?.refresh());
  pi.on("session_shutdown", () => {
    monitor?.dispose();
    monitor = undefined;
    context = undefined;
    report = undefined;
  });
  pi.registerCommand("usage", {
    description: "show provider limits, credits and API key usage",
    getArgumentCompletions: (prefix) =>
      ["refresh", "on", "off"].flatMap((value) =>
        value.startsWith(prefix.trim()) ? [{ value, label: value }] : [],
      ),
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!["", "on", "off", "refresh"].includes(command)) {
        ctx.ui.notify("Use /usage, /usage on, /usage off, or /usage refresh.", "warning");
        return;
      }
      if (!monitor || !report) {
        ctx.ui.notify("Provider usage is available in Pituitary for OpenAI, Claude and OpenRouter.", "info");
        return;
      }
      open = command === "" ? !open : command !== "off";
      publish();
      if (open) void monitor.refresh(command === "refresh");
    },
  });
}
