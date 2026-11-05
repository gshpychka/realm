import { describe, expect, test } from "bun:test";
import { apiUsage, collectUsage, UsageFetchError } from "./providers.ts";
import type { UsageData, UsageFetch, UsageTarget } from "./types.ts";

const openAiSubscription: UsageTarget = {
  provider: "openai",
  auth: "subscription",
  model: "gpt",
  token: "secret-token",
};
const claudeSubscription: UsageTarget = {
  provider: "anthropic",
  auth: "subscription",
  model: "claude",
  token: "secret-token",
};
const openRouterKey: UsageTarget = {
  provider: "openrouter",
  auth: "api",
  model: "openrouter/model",
  token: "secret-token",
};

function jsonFetch(status: number, body: unknown, headers?: Record<string, string>): UsageFetch {
  return async () => new Response(JSON.stringify(body), { status, headers });
}

async function collect(target: UsageTarget, fetcher: UsageFetch): Promise<UsageData> {
  return collectUsage(target, new AbortController().signal, fetcher);
}

/** Asserts `promise` rejects with a `UsageFetchError` and returns it, typed, for further assertions. */
async function expectUsageFetchError(promise: Promise<unknown>): Promise<UsageFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UsageFetchError);
    return error as UsageFetchError;
  }
  throw new Error("expected the promise to reject with a UsageFetchError");
}

// --- transport-level behavior, shared across providers -----------------------------------------

describe("transport", () => {
  test("account queries stay on their provider's endpoint with account-specific authentication", async () => {
    for (const [target, endpoint, body] of [
      [
        { ...openAiSubscription, accountId: "acct_1" },
        "https://chatgpt.com/backend-api/wham/usage",
        { plan_type: "plus" },
      ],
      [claudeSubscription, "https://api.anthropic.com/api/oauth/usage", { five_hour: { utilization: 1 } }],
      [openRouterKey, "https://openrouter.ai/api/v1/key", { data: { limit: null } }],
    ] as const) {
      const calls: Array<[string, RequestInit]> = [];
      await collect(target, async (url, init) => {
        calls.push([url, init]);
        return Response.json(body);
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(endpoint);
      expect(calls[0]?.[1].redirect).toBe("error");
      const headers = new Headers(calls[0]?.[1].headers);
      expect(headers.get("authorization")).toBe("Bearer secret-token");
      if (target.provider === "openai") expect(headers.get("chatgpt-account-id")).toBe("acct_1");
      if (target.provider === "anthropic") expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    }
  });

  test("provider failures do not expose response bodies or credentials", async () => {
    for (const status of [200, 401, 403, 500]) {
      const fetcher: UsageFetch = async () => new Response("secret-token internal trace", { status });
      const error = await expectUsageFetchError(collect(openAiSubscription, fetcher));
      expect(error.message).not.toMatch(/secret-token|internal trace/);
    }
  });

  test("429 with a numeric Retry-After sets retryAt from now", async () => {
    const before = Date.now();
    const fetcher: UsageFetch = async () =>
      new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
    const error = await expectUsageFetchError(collect(openAiSubscription, fetcher));
    expect(error.retryAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(error.retryAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  test("429 with an HTTP-date Retry-After parses the exact timestamp", async () => {
    const fetcher: UsageFetch = async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "Tue, 29 Dec 2099 07:28:00 GMT" },
      });
    const error = await expectUsageFetchError(collect(openAiSubscription, fetcher));
    expect(error.retryAt).toBe(Date.parse("Tue, 29 Dec 2099 07:28:00 GMT"));
  });

  test("429 with no Retry-After leaves retryAt undefined rather than inventing one", async () => {
    const fetcher: UsageFetch = async () => new Response(null, { status: 429 });
    const error = await expectUsageFetchError(collect(openAiSubscription, fetcher));
    expect(error.retryAt).toBeUndefined();
  });

  test("an unrecognized but valid JSON payload fails safe rather than returning an empty success", async () => {
    await expect(collect(openAiSubscription, jsonFetch(200, { unrelated: true }))).rejects.toBeInstanceOf(
      UsageFetchError,
    );
    await expect(collect(claudeSubscription, jsonFetch(200, { unrelated: true }))).rejects.toBeInstanceOf(
      UsageFetchError,
    );
    await expect(
      collect(openRouterKey, jsonFetch(200, { data: { unrelated: true } })),
    ).rejects.toBeInstanceOf(UsageFetchError);
    await expect(collect(openRouterKey, jsonFetch(200, { no_data_key: true }))).rejects.toBeInstanceOf(
      UsageFetchError,
    );
  });

  test("collectUsage for an OpenAI or Claude inference key never makes a network request", async () => {
    let calls = 0;
    const fetcher: UsageFetch = async () => {
      calls++;
      throw new Error("must not be called");
    };
    const openAiKeyTarget: UsageTarget = { ...openAiSubscription, auth: "api" };
    const claudeKeyTarget: UsageTarget = { ...claudeSubscription, auth: "api" };
    const openAiResult = await collectUsage(openAiKeyTarget, new AbortController().signal, fetcher);
    const claudeResult = await collectUsage(claudeKeyTarget, new AbortController().signal, fetcher);
    expect(calls).toBe(0);
    expect(openAiResult.metrics).toEqual([]);
    expect(claudeResult.metrics).toEqual([]);
  });
});

// --- OpenAI subscription -------------------------------------------------------------------------

describe("OpenAI subscription usage", () => {
  test("subscription window durations and reset times retain their provider-reported meaning", async () => {
    const data = await collect(
      openAiSubscription,
      jsonFetch(200, {
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_at: 1_900_000_000 },
          secondary_window: { used_percent: 20, limit_window_seconds: 18_000 },
          unrelated: { used_percent: 99 },
        },
      }),
    );
    expect(data.metrics).toHaveLength(2);
    expect(data.metrics).toContainEqual(
      expect.objectContaining({
        label: "Weekly",
        usedPercent: 10,
        resetsAt: 1_900_000_000_000,
      }),
    );
    const fiveHour = data.metrics.find((metric) => metric.label === "5h");
    expect(fiveHour).toMatchObject({ usedPercent: 20 });
    expect(fiveHour).not.toHaveProperty("resetsAt");
  });

  test("code_review_rate_limit is a direct window group (not nested under its own rate_limit key), prefixed 'Code review'", async () => {
    const body = {
      code_review_rate_limit: {
        primary_window: { used_percent: 2, limit_window_seconds: 604_800 },
        secondary_window: { used_percent: 5, limit_window_seconds: 18_000 },
      },
    };
    const data = await collect(openAiSubscription, jsonFetch(200, body));
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Code review Weekly", usedPercent: 2 }),
    );
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "Code review 5h", usedPercent: 5 }));
  });

  test("additional_rate_limits are prefixed by limit_name or metered_feature so they never collide with the main windows", async () => {
    const body = {
      rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18_000 } },
      additional_rate_limits: [
        {
          limit_name: "Vision",
          rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 3_600 } },
        },
        {
          metered_feature: "Deep research",
          rate_limit: { secondary_window: { used_percent: 4, limit_window_seconds: 86_400 } },
        },
        // Same 5h duration as the main window above: the prefix is what keeps it distinguishable.
        {
          limit_name: "Vision",
          rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18_000 } },
        },
      ],
    };
    const data = await collect(openAiSubscription, jsonFetch(200, body));
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "5h", usedPercent: 1 }));
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "Vision 1h", usedPercent: 3 }));
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Deep research 1d", usedPercent: 4 }),
    );
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "Vision 5h", usedPercent: 9 }));
  });

  test("a null window is valid and simply absent, not a zero-usage metric", async () => {
    const body = {
      rate_limit: {
        primary_window: null,
        secondary_window: { used_percent: 50, limit_window_seconds: 604_800 },
      },
    };
    const data = await collect(openAiSubscription, jsonFetch(200, body));
    expect(data.metrics).toHaveLength(1);
    expect(data.metrics[0]).toMatchObject({ usedPercent: 50 });
  });

  test("used_percent accepts 0, 100, and overage above 100 without clamping", async () => {
    for (const used of [0, 100, 137]) {
      const data = await collect(
        openAiSubscription,
        jsonFetch(200, {
          rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18_000 } },
        }),
      );
      expect(data.metrics[0]).toMatchObject({ usedPercent: used });
    }
  });

  test("a negative used_percent is treated as malformed for that window only", async () => {
    const body = {
      rate_limit: {
        primary_window: { used_percent: -5, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 10, limit_window_seconds: 604_800 },
      },
    };
    const data = await collect(openAiSubscription, jsonFetch(200, body));
    expect(data.metrics).toHaveLength(1);
    expect(data.metrics[0]).toMatchObject({ usedPercent: 10 });
  });

  test("reset_after_seconds is relative to the moment of the response, not invented from nothing", async () => {
    const before = Date.now();
    const data = await collect(
      openAiSubscription,
      jsonFetch(200, {
        rate_limit: {
          primary_window: { used_percent: 1, limit_window_seconds: 18_000, reset_after_seconds: 300 },
        },
      }),
    );
    const after = Date.now();
    const resetsAt = data.metrics[0]?.kind === "window" ? data.metrics[0].resetsAt : undefined;
    expect(resetsAt).toBeDefined();
    const bounded = resetsAt ?? 0;
    expect(bounded).toBeGreaterThanOrEqual(before + 300_000);
    expect(bounded).toBeLessThanOrEqual(after + 300_000);
  });

  test("credits report remaining only, as a number or numeric string, never a fabricated spent amount", async () => {
    const numeric = await collect(
      openAiSubscription,
      jsonFetch(200, { credits: { has_credits: true, unlimited: false, balance: 12.5 } }),
    );
    expect(numeric.metrics).toContainEqual({
      kind: "amount",
      label: "Credits",
      unit: "credits",
      remaining: 12.5,
    });

    const stringBalance = await collect(
      openAiSubscription,
      jsonFetch(200, { credits: { has_credits: true, unlimited: false, balance: "7.25" } }),
    );
    expect(stringBalance.metrics).toContainEqual({
      kind: "amount",
      label: "Credits",
      unit: "credits",
      remaining: 7.25,
    });
    expect(stringBalance.notes.join(" ")).toMatch(/spent/i);

    const notNumeric = await collect(
      openAiSubscription,
      jsonFetch(200, { credits: { has_credits: true, unlimited: false, balance: "many" } }),
    );
    expect(notNumeric.metrics.some((metric) => metric.label === "Credits")).toBe(false);
  });

  test("unlimited credits are noted without inventing a numeric balance", async () => {
    const data = await collect(
      openAiSubscription,
      jsonFetch(200, { credits: { has_credits: true, unlimited: true } }),
    );
    expect(data.metrics.some((metric) => metric.label === "Credits")).toBe(false);
    expect(data.notes.join(" ")).toMatch(/unlimited/i);
  });

  test("has_credits: false (explicitly reported) notes that no extra credits are available", async () => {
    const data = await collect(
      openAiSubscription,
      jsonFetch(200, { plan_type: "free", credits: { has_credits: false, balance: 10 } }),
    );
    expect(data.metrics).toEqual([]);
    expect(data.notes).toContain("No extra credits available.");
  });

  test("plan_type alone, with no windows or credits, notes that windows were not reported instead of succeeding silently", async () => {
    const data = await collect(openAiSubscription, jsonFetch(200, { plan_type: "free" }));
    expect(data.metrics).toEqual([]);
    expect(data.notes).toEqual(["Usage windows not reported."]);
    expect(data.plan).toBe("free");
  });

  test("partial, finite metrics are kept even when other sections are missing or malformed", async () => {
    const data = await collect(
      openAiSubscription,
      jsonFetch(200, {
        rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000 } },
        code_review_rate_limit: "not an object",
        additional_rate_limits: "not an array",
        credits: 12345,
      }),
    );
    expect(data.metrics).toHaveLength(1);
    expect(data.metrics[0]).toMatchObject({ usedPercent: 42 });
  });
});

// --- Claude subscription -------------------------------------------------------------------------

describe("Claude subscription usage", () => {
  test("parses Claude's subscription and scoped weekly window fields", async () => {
    const body = {
      five_hour: { utilization: 10, resets_at: "2099-01-01T00:00:00.000Z" },
      seven_day: { utilization: 20, resets_at: "2099-01-02T00:00:00.000Z" },
      seven_day_sonnet: { utilization: 30, resets_at: "2099-01-03T00:00:00.000Z" },
      seven_day_opus: { utilization: 40, resets_at: "2099-01-04T00:00:00.000Z" },
      seven_day_oauth_apps: { utilization: 50, resets_at: "2099-01-05T00:00:00.000Z" },
      seven_day_routines: { utilization: 65 },
      seven_day_cowork: { utilization: 70 },
      cowork: { utilization: 60, resets_at: "2099-01-06T00:00:00.000Z" },
    };
    const data = await collect(claudeSubscription, jsonFetch(200, body));
    expect(data.metrics).toContainEqual(
      expect.objectContaining({
        label: "5h",
        usedPercent: 10,
        resetsAt: Date.parse(body.five_hour.resets_at),
      }),
    );
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "Weekly", usedPercent: 20 }));
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Weekly (Sonnet)", usedPercent: 30 }),
    );
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "Weekly (Opus)", usedPercent: 40 }));
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Weekly (OAuth apps)", usedPercent: 50 }),
    );
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Weekly (Routines)", usedPercent: 65 }),
    );
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Weekly (Cowork)", usedPercent: 70 }),
    );
    expect(data.metrics).toContainEqual(expect.objectContaining({ label: "Cowork", usedPercent: 60 }));
  });

  test("a null window is valid and produces no metric", async () => {
    const data = await collect(
      claudeSubscription,
      jsonFetch(200, { five_hour: null, seven_day: { utilization: 5, resets_at: "2099-01-01T00:00:00Z" } }),
    );
    expect(data.metrics).toHaveLength(1);
  });

  test("utilization accepts 0, 100 and overage above 100", async () => {
    for (const utilization of [0, 100, 142]) {
      const data = await collect(claudeSubscription, jsonFetch(200, { five_hour: { utilization } }));
      expect(data.metrics[0]).toMatchObject({ usedPercent: utilization });
    }
  });

  test("a malformed resets_at does not fabricate a reset time", async () => {
    const data = await collect(
      claudeSubscription,
      jsonFetch(200, { five_hour: { utilization: 10, resets_at: "not-a-date" } }),
    );
    expect(data.metrics[0]).not.toHaveProperty("resetsAt");
  });

  test("extra_usage reports cents converted to USD", async () => {
    const data = await collect(
      claudeSubscription,
      jsonFetch(200, {
        five_hour: { utilization: 1 },
        extra_usage: { is_enabled: true, monthly_limit: 5_000, used_credits: 1_234 },
      }),
    );
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Extra usage", unit: "USD", used: 12.34, limit: 50 }),
    );
  });

  test("extra usage in another currency is not labeled USD", async () => {
    const data = await collect(
      claudeSubscription,
      jsonFetch(200, {
        five_hour: { utilization: 1 },
        extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1_000, currency: "EUR" },
      }),
    );
    expect(data.metrics.some((metric) => metric.label === "Extra usage")).toBe(false);
    expect(data.notes.join(" ")).toContain("EUR");
  });

  test("extra_usage used_credits and monthly_limit survive independently; neither is required for the other", async () => {
    const usedOnly = await collect(
      claudeSubscription,
      jsonFetch(200, { five_hour: { utilization: 1 }, extra_usage: { is_enabled: true, used_credits: 250 } }),
    );
    const usedOnlyMetric = usedOnly.metrics.find((metric) => metric.label === "Extra usage");
    expect(usedOnlyMetric).toMatchObject({ used: 2.5 });
    expect(usedOnlyMetric).not.toHaveProperty("limit");

    const limitOnly = await collect(
      claudeSubscription,
      jsonFetch(200, {
        five_hour: { utilization: 1 },
        extra_usage: { is_enabled: true, monthly_limit: 10_000 },
      }),
    );
    const limitOnlyMetric = limitOnly.metrics.find((metric) => metric.label === "Extra usage");
    expect(limitOnlyMetric).toMatchObject({ limit: 100 });
    expect(limitOnlyMetric).not.toHaveProperty("used");
  });

  test("extra_usage disabled is distinct from a missing extra_usage: only disabled produces a note", async () => {
    const disabled = await collect(
      claudeSubscription,
      jsonFetch(200, { five_hour: { utilization: 1 }, extra_usage: { is_enabled: false } }),
    );
    expect(disabled.metrics.some((metric) => metric.label === "Extra usage")).toBe(false);
    expect(disabled.notes.join(" ")).toMatch(/disabled/i);

    const missing = await collect(claudeSubscription, jsonFetch(200, { five_hour: { utilization: 1 } }));
    expect(missing.notes).toEqual([]);
  });

  test("extra_usage enabled without finite credit fields reports no metric and no invented zero", async () => {
    const data = await collect(
      claudeSubscription,
      jsonFetch(200, { five_hour: { utilization: 1 }, extra_usage: { is_enabled: true } }),
    );
    expect(data.metrics.some((metric) => metric.label === "Extra usage")).toBe(false);
  });
});

// --- OpenRouter key --------------------------------------------------------------------------------

describe("OpenRouter key usage", () => {
  test("limit_remaining is authoritative and is never derived from lifetime usage", async () => {
    const data = await collect(
      openRouterKey,
      jsonFetch(200, { data: { usage: 500, limit: 100, limit_remaining: 80 } }),
    );
    const keyLimit = data.metrics.find((metric) => metric.label === "Key limit");
    expect(keyLimit).toMatchObject({ limit: 100, remaining: 80 });
    expect(keyLimit).not.toHaveProperty("used");
  });

  test("a null limit is a documented no-cap state, not a missing or zero value", async () => {
    const data = await collect(openRouterKey, jsonFetch(200, { data: { usage: 10, limit: null } }));
    expect(data.metrics.some((metric) => metric.label === "Key limit")).toBe(false);
    expect(data.notes.join(" ")).toMatch(/no spending limit/i);
  });

  test("usage, usage_daily, usage_weekly and usage_monthly are separate USD spend totals from the cap", async () => {
    const data = await collect(
      openRouterKey,
      jsonFetch(200, {
        data: {
          usage: 40,
          usage_daily: 1,
          usage_weekly: 5,
          usage_monthly: 20,
          limit: 100,
          limit_remaining: 60,
        },
      }),
    );
    expect(data.metrics).toContainEqual({ kind: "amount", label: "Lifetime spend", unit: "USD", used: 40 });
    expect(data.metrics).toContainEqual({
      kind: "amount",
      label: "Daily spend",
      unit: "USD",
      used: 1,
      period: "day",
    });
    expect(data.metrics).toContainEqual({
      kind: "amount",
      label: "Weekly spend",
      unit: "USD",
      used: 5,
      period: "week",
    });
    expect(data.metrics).toContainEqual({
      kind: "amount",
      label: "Monthly spend",
      unit: "USD",
      used: 20,
      period: "month",
    });
    expect(data.metrics).toContainEqual(
      expect.objectContaining({ label: "Key limit", limit: 100, remaining: 60 }),
    );
  });

  test("all six enforcement scopes remain distinct and the effective budget stays prominent", async () => {
    const scopes = [
      ["workspace_default_member", "Workspace default member budget"],
      ["workspace_default_key", "Workspace default key budget"],
      ["member", "Member budget"],
      ["api_key", "API key guardrail budget"],
      ["workspace", "Workspace budget"],
      ["key_limit", "Key budget"],
    ] as const;
    const budgets = scopes.map(([scope]) => ({ scope, limit_usd: 10, remaining_usd: 0, spend_usd: 10 }));
    const data = await collect(
      openRouterKey,
      jsonFetch(200, {
        data: {
          usage: 99_999,
          limit: 10,
          limit_remaining: 0,
          budgets: [...budgets, ...Array.from({ length: 40 }, () => budgets[0])],
          effective_budget: budgets[0],
        },
      }),
    );
    for (const [, label] of scopes)
      expect(data.metrics).toContainEqual(
        expect.objectContaining({ label, limit: 10, remaining: 0, used: 10 }),
      );
    expect(data.metrics[0]).toMatchObject({
      label: expect.stringContaining("Effective workspace default member"),
      remaining: 0,
    });
  });

  test("a budget's remaining_usd is shown as-is and never recomputed from the key's lifetime usage", async () => {
    const data = await collect(
      openRouterKey,
      jsonFetch(200, {
        data: {
          usage: 999_999,
          limit: null,
          budgets: [{ scope: "workspace", limit_usd: 50, remaining_usd: 50, spend_usd: 0 }],
        },
      }),
    );
    const budget = data.metrics.find((metric) => metric.label === "Workspace budget");
    expect(budget).toMatchObject({ remaining: 50, used: 0 });
  });

  test("unknown budget scopes have an explicit unavailable note", async () => {
    for (const scope of ["org-wide", "toString", "__proto__"]) {
      const data = await collect(
        openRouterKey,
        jsonFetch(200, {
          data: { budgets: [{ scope, limit_usd: 1, remaining_usd: 1 }] },
        }),
      );
      expect(data.metrics).toEqual([]);
      expect(data.notes.join(" ")).toContain("unrecognized scope");
    }
  });

  test("a budget's own include_byok reports an explicit per-budget note", async () => {
    const data = await collect(
      openRouterKey,
      jsonFetch(200, {
        data: {
          limit: null,
          budgets: [
            { scope: "member", limit_usd: 10, remaining_usd: 4, include_byok: true },
            { scope: "key_limit", limit_usd: 5, remaining_usd: 5, include_byok: false },
          ],
        },
      }),
    );
    expect(data.notes).toContainEqual(
      expect.stringMatching(/member budget includes bring-your-own-key spend/i),
    );
    expect(data.notes).toContainEqual(expect.stringMatching(/key budget excludes bring-your-own-key spend/i));
  });

  test("include_byok_in_limit true and false produce distinct notes", async () => {
    const included = await collect(
      openRouterKey,
      jsonFetch(200, { data: { limit: null, include_byok_in_limit: true } }),
    );
    expect(included.notes.join(" ")).toMatch(/counts toward/i);
    const separate = await collect(
      openRouterKey,
      jsonFetch(200, { data: { limit: null, include_byok_in_limit: false } }),
    );
    expect(separate.notes.join(" ")).toMatch(/separately/i);
  });

  test("free_model_daily_requests is an object with limit/remaining/used, not a bare number", async () => {
    const present = await collect(
      openRouterKey,
      jsonFetch(200, {
        data: { limit: null, free_model_daily_requests: { limit: 50, remaining: 12, used: 38 } },
      }),
    );
    expect(present.metrics).toContainEqual({
      kind: "amount",
      label: "Free daily requests",
      unit: "requests",
      period: "day",
      used: 38,
      limit: 50,
      remaining: 12,
    });
    const missing = await collect(openRouterKey, jsonFetch(200, { data: { limit: null } }));
    expect(missing.metrics.some((metric) => metric.label === "Free daily requests")).toBe(false);
    const bareNumber = await collect(
      openRouterKey,
      jsonFetch(200, { data: { limit: null, free_model_daily_requests: 50 } }),
    );
    expect(bareNumber.metrics.some((metric) => metric.label === "Free daily requests")).toBe(false);
  });
});

// --- apiUsage (inference key, header-based) ---------------------------------------------------

describe("apiUsage", () => {
  test("OpenAI headers are matched case-insensitively and normalized to lowercase", () => {
    const now = Date.now();
    const data = apiUsage(
      "openai",
      { "X-RateLimit-Limit-Requests": "100", "X-RateLimit-Remaining-Requests": "0" },
      now,
    );
    expect(data.metrics).toEqual([
      { kind: "amount", label: "Requests", unit: "requests", limit: 100, remaining: 0 },
    ]);
  });

  test("OpenAI reset durations 6m0s, 1h2m3.5s and 250ms are parsed relative to now", () => {
    const now = 1_000_000;
    const cases: Array<[string, number]> = [
      ["6m0s", 6 * 60_000],
      ["1h2m3.5s", 60 * 60_000 + 2 * 60_000 + 3_500],
      ["250ms", 250],
    ];
    for (const [duration, expectedMs] of cases) {
      const data = apiUsage(
        "openai",
        { "x-ratelimit-limit-requests": "10", "x-ratelimit-reset-requests": duration },
        now,
      );
      const metric = data.metrics.find((item) => item.label === "Requests");
      expect(metric).toMatchObject({ resetsAt: now + expectedMs });
    }
  });

  test("a malformed OpenAI reset duration is dropped without dropping the rest of the metric", () => {
    const data = apiUsage(
      "openai",
      {
        "x-ratelimit-limit-requests": "10",
        "x-ratelimit-remaining-requests": "3",
        "x-ratelimit-reset-requests": "not-a-duration",
      },
      Date.now(),
    );
    expect(data.metrics).toEqual([
      { kind: "amount", label: "Requests", unit: "requests", limit: 10, remaining: 3 },
    ]);
  });

  test("a negative OpenAI reset duration is rejected rather than producing a backwards reset", () => {
    const data = apiUsage(
      "openai",
      { "x-ratelimit-limit-requests": "10", "x-ratelimit-reset-requests": "-5s" },
      Date.now(),
    );
    const metric = data.metrics.find((item) => item.label === "Requests");
    expect(metric).not.toHaveProperty("resetsAt");
  });

  test("an empty or whitespace-only header value is undefined, never a fabricated zero", () => {
    const data = apiUsage(
      "openai",
      { "x-ratelimit-limit-requests": "", "x-ratelimit-remaining-requests": "   " },
      Date.now(),
    );
    expect(data.metrics).toEqual([]);
  });

  test("a negative header value is rejected, never clamped to zero", () => {
    const data = apiUsage("openai", { "x-ratelimit-limit-requests": "-1" }, Date.now());
    expect(data.metrics).toEqual([]);
  });

  test("requests and tokens are independent metrics; absent dimensions are omitted", () => {
    const data = apiUsage("openai", { "x-ratelimit-limit-tokens": "1000" }, Date.now());
    expect(data.metrics).toEqual([{ kind: "amount", label: "Tokens", unit: "tokens", limit: 1000 }]);
  });

  test("Anthropic headers cover requests, tokens, input-tokens and output-tokens with an ISO reset", () => {
    const resetsAt = "2099-01-01T00:00:00.000Z";
    const data = apiUsage(
      "anthropic",
      {
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-requests-remaining": "10",
        "anthropic-ratelimit-requests-reset": resetsAt,
        "anthropic-ratelimit-input-tokens-limit": "100000",
        "anthropic-ratelimit-output-tokens-remaining": "0",
      },
      Date.now(),
    );
    expect(data.metrics).toContainEqual({
      kind: "amount",
      label: "Requests",
      unit: "requests",
      limit: 50,
      remaining: 10,
      resetsAt: Date.parse(resetsAt),
    });
    expect(data.metrics).toContainEqual({
      kind: "amount",
      label: "Input tokens",
      unit: "tokens",
      limit: 100_000,
    });
    expect(data.metrics).toContainEqual({
      kind: "amount",
      label: "Output tokens",
      unit: "tokens",
      remaining: 0,
    });
    expect(data.metrics.some((metric) => metric.label === "Tokens")).toBe(false);
  });

  test("never exposes header values verbatim beyond the parsed numeric fields", () => {
    const data = apiUsage(
      "openai",
      { "x-ratelimit-limit-requests": "100", "x-some-other-header": "secret-value" },
      Date.now(),
    );
    expect(JSON.stringify(data)).not.toContain("secret-value");
  });
});
