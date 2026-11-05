import { createHash } from "node:crypto";
import { apiUsage, collectUsage, UsageFetchError } from "./providers.ts";
import type { UsageData, UsageFetch, UsageProvider, UsageReport, UsageTarget } from "./types.ts";

interface MonitorOptions {
  resolve: () => Promise<UsageTarget | UsageReport | undefined>;
  publish: (report: UsageReport | undefined) => void;
  fetch?: UsageFetch;
  now?: () => number;
  timeoutMs?: number;
}

const INTERVAL = 60_000;
const MIN_REFRESH = 10_000;

/** Account observations are ephemeral and belong to one resolved credential and model selection. */
export class UsageMonitor {
  private report?: UsageReport;
  private identity?: string;
  private observedProvider?: UsageProvider;
  private generation = 0;
  private failures = 0;
  private nextAt = 0;
  private lastAttempt = -Infinity;
  private pending?: Promise<void>;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: MonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  start(initial?: UsageReport): void {
    this.select(initial);
    this.timer ??= setInterval(() => void this.refresh(), INTERVAL);
    this.timer.unref?.();
  }

  select(initial?: UsageReport): void {
    this.generation++;
    this.abort?.abort();
    this.pending = undefined;
    this.identity = undefined;
    this.observedProvider = undefined;
    this.nextAt = 0;
    this.lastAttempt = -Infinity;
    this.failures = 0;
    this.report = initial;
    this.options.publish(initial);
    void this.refresh();
  }

  refresh(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    const now = this.now();
    // Manual refresh respects provider backoff and a minimum interval between requests.
    if (now < this.lastAttempt + MIN_REFRESH || (now < this.nextAt && (!force || this.failures > 0)))
      return Promise.resolve();
    this.lastAttempt = now;
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 15_000);
    const current = () => !this.stopped && generation === this.generation;
    const run = async () => {
      try {
        const resolved = await interruptible(this.options.resolve(), abort.signal);
        if (!current()) return;
        if (!resolved || !("token" in resolved)) {
          this.identity = undefined;
          this.observedProvider = undefined;
          this.set(resolved);
          this.failures = 0;
          this.nextAt = this.now() + INTERVAL;
          return;
        }
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              resolved.provider,
              resolved.auth,
              resolved.model,
              resolved.token,
              resolved.accountId,
            ]),
          )
          .digest("hex");
        if (identity !== this.identity) {
          this.identity = identity;
          this.observedProvider = undefined;
          this.set({
            provider: resolved.provider,
            auth: resolved.auth,
            model: resolved.model,
            state: "loading",
            metrics: [],
            notes: [],
          });
        }
        if (resolved.auth === "api" && resolved.provider !== "openrouter") {
          this.observedProvider = resolved.provider;
          if (this.report) {
            const { error: _error, retryAt: _retryAt, ...report } = this.report;
            this.set({
              ...report,
              state: report.metrics.length ? "ready" : "unavailable",
              notes: apiUsage(resolved.provider, {}, this.now()).notes,
            });
          }
        } else {
          const data = await interruptible(
            collectUsage(resolved, abort.signal, this.options.fetch),
            abort.signal,
          );
          if (!current()) return;
          this.accept(data);
        }
        this.failures = 0;
        this.nextAt = this.now() + INTERVAL;
      } catch (error) {
        if (!current()) return;
        this.failures++;
        this.nextAt = Math.max(
          this.now() + Math.min(INTERVAL * 2 ** (this.failures - 1), 15 * INTERVAL),
          error instanceof UsageFetchError ? (error.retryAt ?? 0) : 0,
        );
        if (this.report)
          this.set({
            ...this.report,
            state: "error",
            error: error instanceof UsageFetchError ? error.message : "Usage refresh failed or timed out.",
            retryAt: this.nextAt,
          });
      } finally {
        clearTimeout(timeout);
        if (current()) {
          this.pending = undefined;
          this.abort = undefined;
        }
      }
    };
    this.pending = run();
    return this.pending;
  }

  observe(headers: Record<string, string>): void {
    if (this.stopped || !this.observedProvider) return;
    const data = apiUsage(this.observedProvider, headers, this.now());
    if (data.metrics.length) this.accept(data);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.abort?.abort();
    clearInterval(this.timer);
    this.options.publish(undefined);
  }

  private accept(data: UsageData): void {
    if (!this.report) return;
    const { error: _error, retryAt: _retryAt, ...report } = this.report;
    this.set({ ...report, ...data, state: "ready", checkedAt: this.now() });
  }

  private set(report: UsageReport | undefined): void {
    this.report = report;
    this.options.publish(report);
  }
}

/** Pi's auth resolver has no signal parameter; a late result cannot hold up session teardown. */
function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("Usage request cancelled."));
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}
