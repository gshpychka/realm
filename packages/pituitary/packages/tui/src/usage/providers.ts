import type { UsageData, UsageFetch, UsageMetric, UsageProvider, UsageTarget } from "./types.ts";

/** A failed account usage request. The message is always safe to display; the body never is. */
export class UsageFetchError extends Error {
  constructor(
    message: string,
    public readonly retryAt?: number,
  ) {
    super(message);
    this.name = "UsageFetchError";
  }
}

const MAX_METRICS = 32;
const MAX_NOTES = 16;
const MAX_LABEL = 40;
const MAX_PERIOD = 32;

function limitArray<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(0, max) : items;
}

/** Provider text is untrusted; strip control bytes (including ESC) before it can reach the terminal. */
function scrub(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
}

function bound(value: string, max: number): string {
  const clean = scrub(value);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseIsoReset(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unrecognized(): UsageFetchError {
  return new UsageFetchError("Usage response had an unrecognized format.");
}

async function requestAccount(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetcher: UsageFetch,
): Promise<unknown> {
  let response: Response;
  try {
    // Fixed account endpoints must never silently follow a redirect to an unexpected host.
    response = await fetcher(url, { headers, signal, redirect: "error" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new UsageFetchError("Usage request could not reach the provider.");
  }
  if (!response.ok) throw await describeFailure(response);
  try {
    return await response.json();
  } catch {
    throw new UsageFetchError("Usage response could not be parsed.");
  }
}

async function describeFailure(response: Response): Promise<UsageFetchError> {
  if (response.status === 429)
    return new UsageFetchError(
      "Usage request was rate limited.",
      parseRetryAfter(response.headers.get("retry-after")),
    );
  if (response.status === 401 || response.status === 403)
    return new UsageFetchError("Usage request was not authorized.");
  return new UsageFetchError(`Usage request failed (status ${response.status}).`);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Date.now() + seconds * 1000;
  const when = Date.parse(trimmed);
  return Number.isFinite(when) ? when : undefined;
}

/** Fetches one resolved credential's account usage from its fixed endpoint; an inference key has no paid probe and gets `apiUsage`'s header-only data instead. */
export async function collectUsage(
  target: UsageTarget,
  signal: AbortSignal,
  fetcher: UsageFetch = fetch,
): Promise<UsageData> {
  if (target.auth === "api" && target.provider !== "openrouter")
    return apiUsage(target.provider, {}, Date.now());
  if (target.provider === "openai") return collectOpenAi(target, signal, fetcher);
  if (target.provider === "anthropic") return collectAnthropic(target, signal, fetcher);
  return collectOpenRouter(target, signal, fetcher);
}

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_NAMED_WINDOWS: Record<number, string> = { 18000: "5h", 604800: "Weekly" };

async function collectOpenAi(
  target: UsageTarget,
  signal: AbortSignal,
  fetcher: UsageFetch,
): Promise<UsageData> {
  const headers: Record<string, string> = { authorization: `Bearer ${target.token}` };
  if (target.accountId) headers["chatgpt-account-id"] = target.accountId;
  return parseOpenAiUsage(await requestAccount(OPENAI_USAGE_URL, headers, signal, fetcher));
}

const OPENAI_RECOGNIZED_KEYS = [
  "rate_limit",
  "code_review_rate_limit",
  "additional_rate_limits",
  "credits",
  "plan_type",
];

function parseOpenAiUsage(payload: unknown): UsageData {
  if (!isRecord(payload)) throw unrecognized();
  const now = Date.now();
  const metrics: UsageMetric[] = [];
  const notes: string[] = [];
  // A recognized key with nothing usable inside it (a malformed sub-field) is still a recognized
  // response; only the complete absence of every known key is an unrecognized payload.
  const recognized = OPENAI_RECOGNIZED_KEYS.some((key) => key in payload);

  const rateLimit = payload.rate_limit;
  if (isRecord(rateLimit)) metrics.push(...parseOpenAiRateLimitGroup(rateLimit, now));

  // code_review_rate_limit is a window group with the same primary_window/secondary_window shape as rate_limit, not nested under its own `rate_limit` key.
  const codeReview = payload.code_review_rate_limit;
  if (isRecord(codeReview)) metrics.push(...parseOpenAiRateLimitGroup(codeReview, now, "Code review"));

  const additional = payload.additional_rate_limits;
  if (Array.isArray(additional))
    for (const entry of additional) {
      if (!isRecord(entry) || !isRecord(entry.rate_limit)) continue;
      // Each additional limit names the feature it meters; without that prefix it would read as a duplicate of the main 5h/Weekly windows.
      const prefix = str(entry.limit_name) ?? str(entry.metered_feature) ?? "Additional";
      metrics.push(...parseOpenAiRateLimitGroup(entry.rate_limit, now, prefix));
    }

  const credits = parseOpenAiCredits(payload.credits);
  if (credits.metric) metrics.push(credits.metric);
  if (credits.note) notes.push(credits.note);

  const plan = str(payload.plan_type);
  if (!metrics.length && !notes.length) {
    if (!recognized) throw unrecognized();
    notes.push("Usage windows not reported.");
  }

  return {
    metrics: limitArray(metrics, MAX_METRICS),
    notes: limitArray(notes, MAX_NOTES),
    ...(plan !== undefined ? { plan: bound(plan, MAX_LABEL) } : {}),
  };
}

/** A window's label always comes from its own `limit_window_seconds`, never from being named primary/secondary. */
function parseOpenAiRateLimitGroup(
  group: Record<string, unknown>,
  now: number,
  prefix?: string,
): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  for (const value of [group.primary_window, group.secondary_window]) {
    const metric = parseOpenAiWindow(value, now, prefix);
    if (metric) metrics.push(metric);
  }
  return metrics;
}

function parseOpenAiWindow(value: unknown, now: number, prefix?: string): UsageMetric | undefined {
  // A null window is an absent limit, not a zero-usage one.
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const usedPercent = num(value.used_percent);
  if (usedPercent === undefined || usedPercent < 0) return undefined;
  const windowSeconds = num(value.limit_window_seconds);
  const resetsAt = resolveOpenAiReset(value.reset_at, value.reset_after_seconds, now);
  const label = openAiWindowLabel(windowSeconds);
  return {
    kind: "window",
    label: bound(prefix ? `${prefix} ${label}` : label, MAX_LABEL),
    usedPercent,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function openAiWindowLabel(seconds: number | undefined): string {
  if (seconds === undefined) return "Usage";
  const named = OPENAI_NAMED_WINDOWS[seconds];
  if (named) return named;
  if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function resolveOpenAiReset(resetAt: unknown, resetAfterSeconds: unknown, now: number): number | undefined {
  const at = num(resetAt);
  if (at !== undefined) return at * 1000;
  const after = num(resetAfterSeconds);
  if (after !== undefined && after >= 0) return now + after * 1000;
  return undefined;
}

function parseOpenAiCredits(value: unknown): { metric?: UsageMetric; note?: string } {
  if (!isRecord(value)) return {};
  if (value.has_credits === false) return { note: "No extra credits available." };
  if (value.has_credits !== true) return {};
  if (value.unlimited === true) return { note: "OpenAI credits balance is unlimited." };
  const balance = parseBalance(value.balance);
  if (balance === undefined) return {};
  return {
    metric: { kind: "amount", label: "Credits", unit: "credits", remaining: balance },
    note: "OpenAI does not report credits spent, only the remaining balance.",
  };
}

function parseBalance(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift
const CLAUDE_WINDOWS: ReadonlyArray<{ key: string; label: string; windowSeconds?: number }> = [
  { key: "five_hour", label: "5h", windowSeconds: 18_000 },
  { key: "seven_day", label: "Weekly", windowSeconds: 604_800 },
  { key: "seven_day_sonnet", label: "Weekly (Sonnet)", windowSeconds: 604_800 },
  { key: "seven_day_opus", label: "Weekly (Opus)", windowSeconds: 604_800 },
  { key: "seven_day_oauth_apps", label: "Weekly (OAuth apps)", windowSeconds: 604_800 },
  { key: "seven_day_routines", label: "Weekly (Routines)", windowSeconds: 604_800 },
  { key: "seven_day_cowork", label: "Weekly (Cowork)", windowSeconds: 604_800 },
  { key: "cowork", label: "Cowork" },
];

async function collectAnthropic(
  target: UsageTarget,
  signal: AbortSignal,
  fetcher: UsageFetch,
): Promise<UsageData> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.token}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
  return parseClaudeUsage(await requestAccount(ANTHROPIC_USAGE_URL, headers, signal, fetcher));
}

function parseClaudeUsage(payload: unknown): UsageData {
  if (!isRecord(payload)) throw unrecognized();
  const metrics: UsageMetric[] = [];
  const notes: string[] = [];

  for (const window of CLAUDE_WINDOWS) {
    const metric = parseClaudeWindow(payload, window.key, window.label, window.windowSeconds);
    if (metric) metrics.push(metric);
  }

  const extra = parseClaudeExtraUsage(payload.extra_usage);
  if (extra.metric) metrics.push(extra.metric);
  if (extra.note) notes.push(extra.note);

  if (!metrics.length && !notes.length) throw unrecognized();
  return { metrics: limitArray(metrics, MAX_METRICS), notes: limitArray(notes, MAX_NOTES) };
}

function parseClaudeWindow(
  payload: Record<string, unknown>,
  key: string,
  label: string,
  windowSeconds?: number,
): UsageMetric | undefined {
  const value = payload[key];
  // A null window is an absent limit, not a zero-usage one.
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const usedPercent = num(value.utilization);
  if (usedPercent === undefined || usedPercent < 0) return undefined;
  const resetsAt = parseIsoReset(value.resets_at);
  return {
    kind: "window",
    label: bound(label, MAX_LABEL),
    usedPercent,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/** `is_enabled: false` (reported) and a missing `extra_usage` (not reported) are distinct states. */
function parseClaudeExtraUsage(value: unknown): { metric?: UsageMetric; note?: string } {
  if (!isRecord(value)) return {};
  if (value.is_enabled === false) return { note: "Claude extra usage billing is disabled for this account." };
  if (value.is_enabled !== true) return {};
  const currency = str(value.currency)?.toUpperCase();
  if (currency && currency !== "USD")
    return { note: `Extra usage amounts are unavailable in currency ${bound(currency, 8)}.` };
  const used = num(value.used_credits);
  const limit = num(value.monthly_limit);
  if (used === undefined && limit === undefined) return {};
  // Anthropic reports extra usage in cents.
  return {
    metric: {
      kind: "amount",
      label: "Extra usage",
      unit: "USD",
      period: "month",
      ...(used !== undefined ? { used: used / 100 } : {}),
      ...(limit !== undefined ? { limit: limit / 100 } : {}),
    },
  };
}

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
// https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
const OPENROUTER_BUDGET_SCOPE_LABELS = new Map([
  ["workspace_default_member", "workspace default member budget"],
  ["workspace_default_key", "workspace default key budget"],
  ["member", "member budget"],
  ["api_key", "API key guardrail budget"],
  ["workspace", "workspace budget"],
  ["key_limit", "key budget"],
]);

async function collectOpenRouter(
  target: UsageTarget,
  signal: AbortSignal,
  fetcher: UsageFetch,
): Promise<UsageData> {
  const headers: Record<string, string> = { authorization: `Bearer ${target.token}` };
  return parseOpenRouterUsage(await requestAccount(OPENROUTER_KEY_URL, headers, signal, fetcher));
}

const OPENROUTER_RECOGNIZED_KEYS = [
  "usage",
  "usage_daily",
  "usage_weekly",
  "usage_monthly",
  "byok_usage",
  "byok_usage_daily",
  "byok_usage_weekly",
  "byok_usage_monthly",
  "limit",
  "limit_remaining",
  "free_model_daily_requests",
  "budgets",
  "effective_budget",
  "include_byok_in_limit",
];

function parseOpenRouterUsage(payload: unknown): UsageData {
  if (!isRecord(payload)) throw unrecognized();
  const data = payload.data;
  if (!isRecord(data)) throw unrecognized();

  const metrics: UsageMetric[] = [];
  const notes: string[] = [];
  const recognized = OPENROUTER_RECOGNIZED_KEYS.some((key) => key in data);
  const effective = parseOpenRouterBudget(data.effective_budget, "Effective");
  if (effective.metric) metrics.push(effective.metric);
  if (effective.note) notes.push(effective.note);

  if (data.limit === null) notes.push("OpenRouter key has no spending limit.");
  else {
    const limit = num(data.limit);
    // limit_remaining is authoritative for the key's current cap; it is never derived by
    // subtracting lifetime `usage` from `limit`, since the cap can reset on its own interval.
    const remaining = num(data.limit_remaining);
    if (limit !== undefined || remaining !== undefined) {
      const period = str(data.limit_reset);
      metrics.push({
        kind: "amount",
        label: "Key limit",
        unit: "USD",
        ...(limit !== undefined ? { limit } : {}),
        ...(remaining !== undefined ? { remaining } : {}),
        ...(period !== undefined ? { period: bound(period, MAX_PERIOD) } : {}),
      });
    }
  }

  if (Array.isArray(data.budgets))
    for (const entry of data.budgets) {
      const { metric, note } = parseOpenRouterBudget(entry);
      if (metric) metrics.push(metric);
      if (note) notes.push(note);
    }

  const freeRequests = parseOpenRouterFreeRequests(data.free_model_daily_requests);
  if (freeRequests) {
    metrics.push(freeRequests);
    notes.push("Free-model daily quota is account-shared; exempt and BYOK requests are not gated by it.");
  }

  const pushSpend = (key: string, label: string, period?: "day" | "week" | "month"): void => {
    const used = num(data[key]);
    if (used === undefined) return;
    metrics.push({ kind: "amount", label, unit: "USD", used, ...(period ? { period } : {}) });
  };
  pushSpend("usage", "Lifetime spend");
  pushSpend("usage_daily", "Daily spend", "day");
  pushSpend("usage_weekly", "Weekly spend", "week");
  pushSpend("usage_monthly", "Monthly spend", "month");
  pushSpend("byok_usage", "BYOK lifetime spend");
  pushSpend("byok_usage_daily", "BYOK daily spend", "day");
  pushSpend("byok_usage_weekly", "BYOK weekly spend", "week");
  pushSpend("byok_usage_monthly", "BYOK monthly spend", "month");

  if (typeof data.include_byok_in_limit === "boolean")
    notes.push(
      data.include_byok_in_limit
        ? "Bring-your-own-key usage counts toward the key limit."
        : "Bring-your-own-key usage is tracked separately from the key limit.",
    );

  if (!metrics.length && !notes.length && !recognized) throw unrecognized();
  return { metrics: limitArray(metrics, MAX_METRICS), notes: limitArray(notes, MAX_NOTES) };
}

function parseOpenRouterFreeRequests(value: unknown): UsageMetric | undefined {
  if (!isRecord(value)) return undefined;
  const limit = num(value.limit);
  const remaining = num(value.remaining);
  const used = num(value.used);
  if (limit === undefined && remaining === undefined && used === undefined) return undefined;
  return {
    kind: "amount",
    label: "Free daily requests",
    unit: "requests",
    period: "day",
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `remaining_usd`/`spend_usd` are authoritative; a budget's remaining is never recomputed from the key's lifetime usage. */
function parseOpenRouterBudget(entry: unknown, prefix?: string): { metric?: UsageMetric; note?: string } {
  if (!isRecord(entry)) return {};
  const scope = str(entry.scope);
  const scopeLabel = scope ? OPENROUTER_BUDGET_SCOPE_LABELS.get(scope) : undefined;
  if (!scopeLabel)
    return { note: "A reported budget has an unrecognized scope; its amounts are unavailable." };
  const limit = num(entry.limit_usd);
  const remaining = num(entry.remaining_usd);
  const used = num(entry.spend_usd);
  if (limit === undefined && remaining === undefined && used === undefined) return {};
  const label = bound(prefix ? `${prefix} ${scopeLabel}` : capitalize(scopeLabel), MAX_LABEL);
  const period = str(entry.reset_interval);
  const resetsAt = parseIsoReset(entry.resets_at);
  const metric: UsageMetric = {
    kind: "amount",
    label,
    unit: "USD",
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(period !== undefined ? { period: bound(period, MAX_PERIOD) } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
  if (typeof entry.include_byok !== "boolean") return { metric };
  const inclusion = entry.include_byok ? "includes" : "excludes";
  return { metric, note: `${label} ${inclusion} bring-your-own-key spend.` };
}

const API_NOTES: readonly string[] = [
  "Shows the most recently observed API response headers.",
  "Limits can be shared across models, projects, or the organization.",
  "Billing and spend are not available with an inference API key.",
];

/** Builds usage from one response's rate-limit headers; empty headers return the fixed notes with no metrics. */
export function apiUsage(provider: UsageProvider, headers: Record<string, string>, now: number): UsageData {
  const lower = lowercaseHeaders(headers);
  if (provider === "openai")
    return { metrics: limitArray(openAiHeaderMetrics(lower, now), MAX_METRICS), notes: [...API_NOTES] };
  if (provider === "anthropic")
    return { metrics: limitArray(anthropicHeaderMetrics(lower), MAX_METRICS), notes: [...API_NOTES] };
  return { metrics: [], notes: [] };
}

function lowercaseHeaders(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers))
    if (typeof value === "string") map.set(key.toLowerCase(), value);
  return map;
}

function parseNumberHeader(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const OPENAI_HEADER_DIMENSIONS = [
  ["requests", "Requests"],
  ["tokens", "Tokens"],
] as const;

function openAiHeaderMetrics(headers: Map<string, string>, now: number): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  for (const [key, label] of OPENAI_HEADER_DIMENSIONS) {
    const limit = parseNumberHeader(headers.get(`x-ratelimit-limit-${key}`));
    const remaining = parseNumberHeader(headers.get(`x-ratelimit-remaining-${key}`));
    if (limit === undefined && remaining === undefined) continue;
    const resetMs = parseGoDuration(headers.get(`x-ratelimit-reset-${key}`));
    metrics.push({
      kind: "amount",
      label,
      unit: key,
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetMs !== undefined ? { resetsAt: now + resetMs } : {}),
    });
  }
  return metrics;
}

const ANTHROPIC_HEADER_DIMENSIONS = [
  ["requests", "Requests", "requests"],
  ["tokens", "Tokens", "tokens"],
  ["input-tokens", "Input tokens", "tokens"],
  ["output-tokens", "Output tokens", "tokens"],
] as const;

function anthropicHeaderMetrics(headers: Map<string, string>): UsageMetric[] {
  const metrics: UsageMetric[] = [];
  for (const [key, label, unit] of ANTHROPIC_HEADER_DIMENSIONS) {
    const limit = parseNumberHeader(headers.get(`anthropic-ratelimit-${key}-limit`));
    const remaining = parseNumberHeader(headers.get(`anthropic-ratelimit-${key}-remaining`));
    if (limit === undefined && remaining === undefined) continue;
    const resetsAt = parseIsoReset(headers.get(`anthropic-ratelimit-${key}-reset`));
    metrics.push({
      kind: "amount",
      label,
      unit,
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  return metrics;
}

/** Longer unit tokens are tried first so "ms" is not matched as the minute unit "m" plus a stray "s". */
const GO_DURATION = /(\d+(?:\.\d+)?)(ms|ns|us|µs|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parses a Go-style duration ("6m0s", "1h2m3.5s", "250ms") as OpenAI's `x-ratelimit-reset-*` headers report it. */
function parseGoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  GO_DURATION.lastIndex = 0;
  let total = 0;
  let index = 0;
  let matched = false;
  for (const match of trimmed.matchAll(GO_DURATION)) {
    if (match.index !== index) return undefined;
    const amount = Number(match[1]);
    const unit = match[2] as string;
    const scale = GO_DURATION_UNIT_MS[unit];
    if (!Number.isFinite(amount) || amount < 0 || scale === undefined) return undefined;
    total += amount * scale;
    index = match.index + match[0].length;
    matched = true;
  }
  if (!matched || index !== trimmed.length || !Number.isFinite(total)) return undefined;
  return total;
}
