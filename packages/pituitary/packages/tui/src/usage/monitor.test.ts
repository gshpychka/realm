import { expect, test } from "bun:test";
import { UsageMonitor } from "./monitor.ts";
import type { UsageReport, UsageTarget } from "./types.ts";

const target: UsageTarget = { provider: "openai", auth: "subscription", model: "test", token: "secret" };
const initial: UsageReport = {
  provider: "openai",
  auth: "subscription",
  model: "test",
  state: "loading",
  metrics: [],
  notes: [],
};
const body = (used = 42) => ({
  rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18000 } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("polls coalesce, successes cache, and manual refresh has a minimum interval", async () => {
  let now = 100_000,
    requests = 0;
  const states: Array<UsageReport | undefined> = [];
  const monitor = new UsageMonitor({
    now: () => now,
    resolve: async () => target,
    publish: (report) => states.push(report),
    fetch: async () => {
      requests++;
      return Response.json(body());
    },
  });
  try {
    monitor.start(initial);
    await Promise.all([monitor.refresh(), monitor.refresh(true)]);
    expect(requests).toBe(1);
    expect(states.at(-1)).toMatchObject({ state: "ready", checkedAt: 100_000 });
    await monitor.refresh(true);
    expect(requests).toBe(1);
    now += 10_000;
    await monitor.refresh();
    expect(requests).toBe(1);
    await monitor.refresh(true);
    expect(requests).toBe(2);
    expect(JSON.stringify(states)).not.toContain("secret");
  } finally {
    monitor.dispose();
  }
});

test("failed refresh retains dated observations and honors server backoff even for manual refresh", async () => {
  let now = 100_000,
    requests = 0;
  let report: UsageReport | undefined;
  const monitor = new UsageMonitor({
    now: () => now,
    resolve: async () => target,
    publish: (next) => {
      report = next;
    },
    fetch: async () => {
      requests++;
      return requests === 1
        ? Response.json(body())
        : new Response("secret provider error", { status: 429, headers: { "retry-after": "600" } });
    },
  });
  try {
    monitor.start(initial);
    await monitor.refresh();
    now += 60_000;
    await monitor.refresh();
    expect(report).toMatchObject({ state: "error", checkedAt: 100_000 });
    expect(report?.metrics).toHaveLength(1);
    expect(report?.retryAt).toBeGreaterThan(now);
    expect(JSON.stringify(report)).not.toContain("secret");
    now += 10_000;
    await monitor.refresh(true);
    expect(requests).toBe(2);
  } finally {
    monitor.dispose();
  }
});

test("model changes abort old requests and ignore late results", async () => {
  const delayed = deferred<Response>();
  let selected = target;
  let requests = 0;
  let report: UsageReport | undefined;
  const signals: AbortSignal[] = [];
  const monitor = new UsageMonitor({
    resolve: async () => selected,
    publish: (next) => {
      report = next;
    },
    fetch: async (_url, init) => {
      signals.push(init.signal as AbortSignal);
      return ++requests === 1 ? delayed.promise : Response.json(body(9));
    },
  });
  try {
    monitor.start(initial);
    await Bun.sleep(0);
    expect(requests).toBe(1);
    selected = { ...target, model: "other", token: "other-secret" };
    monitor.select({ ...initial, model: "other" });
    expect(signals[0]?.aborted).toBe(true);
    await monitor.refresh();
    expect(report).toMatchObject({ model: "other", metrics: [{ usedPercent: 9 }] });
    delayed.resolve(Response.json(body(99)));
    await Bun.sleep(0);
    expect(report).toMatchObject({ model: "other", metrics: [{ usedPercent: 9 }] });
  } finally {
    monitor.dispose();
  }
});

test("credential replacement never reuses another account's last good observation", async () => {
  let now = 100_000;
  let selected = target;
  let report: UsageReport | undefined;
  let requests = 0;
  const monitor = new UsageMonitor({
    now: () => now,
    resolve: async () => selected,
    publish: (next) => {
      report = next;
    },
    fetch: async () => (++requests === 1 ? Response.json(body()) : new Response(null, { status: 403 })),
  });
  try {
    monitor.start(initial);
    await monitor.refresh();
    selected = { ...target, token: "new-account" };
    now += 60_000;
    await monitor.refresh();
    expect(report).toMatchObject({ state: "error", metrics: [] });
    expect(report?.checkedAt).toBeUndefined();
  } finally {
    monitor.dispose();
  }
});

test("inference keys use observed response headers without making paid probe requests", async () => {
  let now = 100_000,
    requests = 0;
  let report: UsageReport | undefined;
  const monitor = new UsageMonitor({
    now: () => now,
    resolve: async () => ({ ...target, auth: "api" }),
    publish: (next) => {
      report = next;
    },
    fetch: async () => {
      requests++;
      throw new Error("must not request");
    },
  });
  try {
    monitor.start({ ...initial, auth: "api" });
    await monitor.refresh();
    expect(report).toMatchObject({ state: "unavailable", metrics: [] });
    monitor.observe({ "anthropic-ratelimit-requests-limit": "100" });
    expect(report?.metrics).toEqual([]);
    monitor.observe({ "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0" });
    expect(report).toMatchObject({ state: "ready", checkedAt: now, metrics: [{ remaining: 0 }] });
    now += 60_000;
    await monitor.refresh();
    expect(report?.checkedAt).toBe(100_000);
    expect(requests).toBe(0);
  } finally {
    monitor.dispose();
  }
});

test("auth deadlines and shutdown bound non-cooperating async work", async () => {
  const auth = deferred<UsageTarget>();
  const states: Array<UsageReport | undefined> = [];
  const monitor = new UsageMonitor({
    resolve: () => auth.promise,
    publish: (report) => states.push(report),
    timeoutMs: 5,
  });
  monitor.start(initial);
  await monitor.refresh();
  expect(states.at(-1)).toMatchObject({ state: "error" });
  monitor.dispose();
  const count = states.length;
  auth.resolve(target);
  await Bun.sleep(0);
  expect(states).toHaveLength(count);
  expect(states.at(-1)).toBeUndefined();
  monitor.dispose();
});
