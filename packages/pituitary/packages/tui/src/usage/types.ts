export const USAGE_STATUS = "pituitary.usage";

export type UsageProvider = "openai" | "anthropic" | "openrouter";
export type UsageAuth = "subscription" | "api";

export type UsageMetric =
  | {
      kind: "window";
      label: string;
      usedPercent: number;
      windowSeconds?: number;
      resetsAt?: number;
    }
  | {
      kind: "amount";
      label: string;
      unit: "USD" | "credits" | "requests" | "tokens";
      used?: number;
      limit?: number;
      remaining?: number;
      period?: string;
      resetsAt?: number;
    };

/** Provider-reported account data; session token costs have a separate ledger. */
export interface UsageReport {
  provider: UsageProvider;
  auth: UsageAuth;
  model: string;
  state: "loading" | "ready" | "unavailable" | "error";
  plan?: string;
  checkedAt?: number;
  retryAt?: number;
  error?: string;
  metrics: UsageMetric[];
  notes: string[];
}

/** Only this credential-free projection crosses Pi's extension UI boundary. */
export interface UsageDisplay {
  report: UsageReport;
  open: boolean;
}

export interface UsageTarget {
  provider: UsageProvider;
  auth: UsageAuth;
  model: string;
  token: string;
  accountId?: string;
}

export type UsageFetch = (url: string, init: RequestInit) => Promise<Response>;
export type UsageData = Pick<UsageReport, "metrics" | "notes" | "plan">;
