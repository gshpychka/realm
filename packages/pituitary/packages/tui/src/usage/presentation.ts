import { plain } from "@pituitary/session";
import { counted } from "../plural.ts";
import { headCells } from "../text-width.ts";
import { duration } from "../working.ts";
import type { UsageAuth, UsageDisplay, UsageMetric, UsageProvider, UsageReport } from "./types.ts";

type AmountMetric = Extract<UsageMetric, { kind: "amount" }>;
type WindowMetric = Extract<UsageMetric, { kind: "window" }>;
type AmountUnit = AmountMetric["unit"];

/** Age past which a fetched report can no longer speak for the account's current state. */
const STALE_AGE_MS = 120_000;

const MAX_LABEL = 80;
const MAX_MODEL = 200;
const MAX_NOTE = 500;
const MAX_METRICS = 64;
const MAX_NOTES = 32;
/** Bound on `decodeUsage`'s input, checked before `JSON.parse` touches it. */
const MAX_PAYLOAD_CHARS = 128 * 1024;

const PROVIDERS: readonly UsageProvider[] = ["openai", "anthropic", "openrouter"];
const AUTHS: readonly UsageAuth[] = ["subscription", "api"];
const STATES: readonly UsageReport["state"][] = ["loading", "ready", "unavailable", "error"];
const UNITS: readonly AmountUnit[] = ["USD", "credits", "requests", "tokens"];

/** `text` with escapes and control characters gone, folded to one line and trimmed. */
export function singleLine(text: string): string {
  return plain(text).replace(/\s+/g, " ").trim();
}

/** `value` as a bounded single-line label, or `undefined` when it is not a usable string. */
function label(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = singleLine(value);
  return flat ? headCells(flat, max) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function decodeMetric(raw: unknown): UsageMetric | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === "window") {
    const metricLabel = label(r.label, MAX_LABEL);
    const usedPercent = finite(r.usedPercent);
    if (metricLabel === undefined || usedPercent === undefined) return undefined;
    const windowSeconds = finite(r.windowSeconds);
    const resetsAt = finite(r.resetsAt);
    return {
      kind: "window",
      label: metricLabel,
      usedPercent,
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  }
  if (r.kind === "amount") {
    const metricLabel = label(r.label, MAX_LABEL);
    const unit = oneOf(r.unit, UNITS);
    if (metricLabel === undefined || unit === undefined) return undefined;
    const used = finite(r.used);
    const limit = finite(r.limit);
    const remaining = finite(r.remaining);
    const period = label(r.period, MAX_LABEL);
    const resetsAt = finite(r.resetsAt);
    return {
      kind: "amount",
      label: metricLabel,
      unit,
      ...(used !== undefined ? { used } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(period !== undefined ? { period } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };
  }
  return undefined;
}

/**
 * `text` as a `UsageDisplay`, or `undefined` when it is not one: an invalid metric or note
 * drops on its own, while a missing required report field rejects the whole payload.
 */
export function decodeUsage(text?: string): UsageDisplay | undefined {
  if (!text || text.length > MAX_PAYLOAD_CHARS) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const root = raw as Record<string, unknown>;
  if (!root.report || typeof root.report !== "object") return undefined;
  const r = root.report as Record<string, unknown>;
  const provider = oneOf(r.provider, PROVIDERS);
  const auth = oneOf(r.auth, AUTHS);
  const model = label(r.model, MAX_MODEL);
  const state = oneOf(r.state, STATES);
  if (!provider || !auth || model === undefined || !state) return undefined;
  const metrics = Array.isArray(r.metrics)
    ? r.metrics
        .slice(0, MAX_METRICS)
        .map(decodeMetric)
        .filter((metric): metric is UsageMetric => metric !== undefined)
    : [];
  const notes = Array.isArray(r.notes)
    ? r.notes
        .slice(0, MAX_NOTES)
        .map((note) => label(note, MAX_NOTE))
        .filter((note): note is string => note !== undefined)
    : [];
  const plan = label(r.plan, MAX_LABEL);
  const checkedAt = finite(r.checkedAt);
  const retryAt = finite(r.retryAt);
  const error = label(r.error, MAX_NOTE);
  const report: UsageReport = {
    provider,
    auth,
    model,
    state,
    metrics,
    notes,
    ...(plan !== undefined ? { plan } : {}),
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  return { report, open: root.open === true };
}

/** Whether `report`'s figures can still speak for the account: a fetch new enough, with no metric's own reset already passed. */
export function isUsageStale(report: UsageReport, now: number): boolean {
  if (report.state === "error") return true;
  const aged = report.checkedAt !== undefined && now - report.checkedAt > STALE_AGE_MS;
  return aged || report.metrics.some((metric) => expired(metric, now));
}

function expired(metric: UsageMetric, now: number): boolean {
  return metric.resetsAt !== undefined && metric.resetsAt <= now;
}

/** A deadline already past has no inferred renewal to report; only a future one counts down. */
function resetPhrase(resetsAt: number, now: number): string {
  return resetsAt <= now ? "reset passed · awaiting refresh" : `resets in ${duration(resetsAt - now)}`;
}

function formatQuantity(value: number, unit: AmountUnit): string {
  switch (unit) {
    case "USD":
      return `$${value.toFixed(2)}`;
    case "credits":
      return `${value.toFixed(2)} credits`;
    case "requests":
      return counted(Math.round(value), "request");
    case "tokens":
      return counted(Math.round(value), "token");
  }
}

/** A negative remaining is spending past the budget, worded as an overage rather than a bare sign. */
function formatRemaining(value: number, unit: AmountUnit): string {
  return value < 0 ? `${formatQuantity(-value, unit)} over` : formatQuantity(value, unit);
}

function windowDetail(metric: WindowMetric, now: number): string {
  const segments = [`${Math.round(metric.usedPercent)}% used`];
  if (metric.windowSeconds !== undefined) segments.push(`of ${duration(metric.windowSeconds * 1000)}`);
  if (metric.resetsAt !== undefined) segments.push(resetPhrase(metric.resetsAt, now));
  return segments.join(" · ");
}

/** `used`, `limit`, `remaining` and `period` only where the provider gave them; nothing inferred. */
function amountDetail(metric: AmountMetric, now: number): string {
  const segments: string[] = [];
  if (metric.used !== undefined) segments.push(`used ${formatQuantity(metric.used, metric.unit)}`);
  if (metric.limit !== undefined) segments.push(`limit ${formatQuantity(metric.limit, metric.unit)}`);
  if (metric.remaining !== undefined)
    segments.push(`remaining ${formatRemaining(metric.remaining, metric.unit)}`);
  if (metric.period) segments.push(`period ${singleLine(metric.period)}`);
  if (metric.resetsAt !== undefined) segments.push(resetPhrase(metric.resetsAt, now));
  return segments.join(" · ");
}

/** One metric row, in words, with nothing the provider left unset filled in by guesswork. */
export interface MetricLine {
  label: string;
  detail: string;
  /** The metric's own window or period reset already passed without a refreshed figure. */
  expired: boolean;
}

/** `metric` at `now`, sanitised and worded for either a window's percentage or an amount's ledger. */
export function metricLine(metric: UsageMetric, now: number): MetricLine {
  const detail = metric.kind === "window" ? windowDetail(metric, now) : amountDetail(metric, now);
  return { label: singleLine(metric.label), detail, expired: expired(metric, now) };
}

const PROVIDER_NAMES: Record<UsageProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};
const AUTH_LABELS: Record<UsageAuth, string> = { subscription: "sub", api: "API" };

/** The account this report describes: provider, API-key or subscription auth, model, and plan. */
export function providerLine(report: UsageReport): string {
  return [
    PROVIDER_NAMES[report.provider],
    AUTH_LABELS[report.auth],
    singleLine(report.model),
    report.plan ? singleLine(report.plan) : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** How current `report` is, or why it is not: loading, unavailable, a fetch error and its retry, or its age. */
export function statusLine(report: UsageReport, now: number): string {
  if (report.state === "loading") return "fetching usage…";
  if (report.state === "unavailable") return "usage unavailable";
  if (report.state === "error") {
    const message = report.error ? singleLine(report.error) : "usage refresh failed";
    const retry =
      report.retryAt !== undefined && report.retryAt > now
        ? ` · retry in ${duration(report.retryAt - now)}`
        : "";
    return `${message}${retry}`;
  }
  if (report.checkedAt === undefined) return isUsageStale(report, now) ? "stale" : "ready";
  const age = `updated ${duration(Math.max(0, now - report.checkedAt))} ago`;
  return isUsageStale(report, now) ? `${age} · stale` : age;
}

/** The session's own token ledger, worded apart from the account's provider-reported billing. */
export function sessionEstimateLine(sessionCost: number): string {
  return `session estimate $${sessionCost.toFixed(2)} · not account billing`;
}

/** Fixed per provider and auth; OpenAI's ChatGPT sign-in has no usage API to fetch instead (openai/codex#54219). */
const DASHBOARD_URLS: Record<UsageProvider, Record<UsageAuth, string>> = {
  openai: { subscription: "https://chatgpt.com/settings/usage", api: "https://platform.openai.com/usage" },
  anthropic: { subscription: "https://claude.ai/settings/usage", api: "https://platform.claude.com/usage" },
  openrouter: {
    subscription: "https://openrouter.ai/settings/keys",
    api: "https://openrouter.ai/settings/keys",
  },
};

/** The fixed address of `report`'s own account dashboard, for the usage this report cannot fetch. */
export function dashboardUrl(report: Pick<UsageReport, "provider" | "auth">): string {
  return DASHBOARD_URLS[report.provider][report.auth];
}
