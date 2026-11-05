import { expect, test } from "bun:test";
import { decodeUsage, metricLine } from "./presentation.ts";
import type { UsageReport } from "./types.ts";

const NOW = 1_700_000_000_000;

function report(partial: Partial<UsageReport> = {}): UsageReport {
  return {
    provider: "anthropic",
    auth: "subscription",
    model: "claude",
    state: "ready",
    checkedAt: NOW,
    metrics: [],
    notes: [],
    ...partial,
  };
}

test("an explicit zero remaining renders as zero rather than falling back to another field", () => {
  const line = metricLine(
    { kind: "amount", label: "requests", unit: "requests", remaining: 0, used: 10 },
    NOW,
  );
  expect(line.detail).toContain("remaining 0 requests");
});

test("an absent limit is omitted rather than reported as unlimited", () => {
  const line = metricLine({ kind: "amount", label: "tokens", unit: "tokens", used: 500 }, NOW);
  expect(line.detail).toContain("500 tokens");
  expect(line.detail).not.toMatch(/limit|unlimited/);
});

test("credits are worded as credits, not dollars", () => {
  const line = metricLine({ kind: "amount", label: "balance", unit: "credits", used: 12.5, limit: 50 }, NOW);
  expect(line.detail).toMatch(/12\.50 credits.*50\.00 credits/);
  expect(line.detail).not.toContain("$");
});

test("a negative remaining is worded as an overage rather than a bare negative number", () => {
  const line = metricLine({ kind: "amount", label: "balance", unit: "USD", remaining: -5 }, NOW);
  expect(line.detail).toBe("remaining $5.00 over");
});

test("unrecognized report shapes cannot become usage displays", () => {
  expect(decodeUsage(JSON.stringify({ report: { provider: "anthropic" } }))).toBeUndefined();
  expect(decodeUsage(JSON.stringify({ report: { ...report(), provider: "made-up" } }))).toBeUndefined();
  expect(decodeUsage(JSON.stringify({ report: { ...report(), state: "made-up" } }))).toBeUndefined();
});

test("unknown properties never survive the boundary, wherever they are nested", () => {
  const payload = JSON.stringify({
    report: {
      ...report(),
      token: "sk-should-not-travel",
      metrics: [{ kind: "amount", label: "requests", unit: "requests", used: 1, apiKey: "sk-nested-secret" }],
    },
    open: false,
    extra: "also dropped",
  });
  const decoded = decodeUsage(payload);
  const serialised = JSON.stringify(decoded);
  expect(serialised).not.toContain("sk-should-not-travel");
  expect(serialised).not.toContain("sk-nested-secret");
  expect(serialised).not.toContain("extra");
});

test("a hostile payload is scrubbed of escape sequences, folded to one line, and bounded in length", () => {
  const payload = JSON.stringify({
    report: {
      ...report(),
      model: "claude\x1b[31m\x07",
      plan: "line one\nline two\ttabbed",
      error: "\x1b]0;evil\x07boom",
      metrics: [
        {
          kind: "amount",
          label: "a".repeat(500),
          unit: "requests",
          used: 1,
          period: "multi\nline\nperiod",
        },
      ],
      notes: ["note\x1b[0m with escape", "b".repeat(1000)],
    },
    open: true,
  });
  const decoded = decodeUsage(payload);
  expect(decoded).toBeDefined();
  const report_ = decoded?.report;
  // biome-ignore lint/style/noNonNullAssertion: asserted defined above
  expect(report_!.model).toBe("claude");
  // biome-ignore lint/style/noNonNullAssertion: asserted defined above
  expect(report_!.plan).toBe("line one line two tabbed");
  // biome-ignore lint/style/noNonNullAssertion: asserted defined above
  expect(report_!.error).toBe("boom");
  const metric = report_?.metrics[0];
  expect(metric?.kind).toBe("amount");
  expect(metric?.label.length).toBeLessThan(500);
  expect(metric && metric.kind === "amount" ? metric.period : undefined).toBe("multi line period");
  expect(report_?.notes[0]).toBe("note with escape");
  expect(report_?.notes[1]?.length).toBeLessThan(1000);
  for (const value of [report_?.model, report_?.plan, report_?.error, ...(report_?.notes ?? [])]) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the scrub removed them
    expect(value).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  }
});

test("an invalid metric or note drops on its own without rejecting the rest of the report", () => {
  const payload = JSON.stringify({
    report: {
      ...report(),
      metrics: [
        { kind: "window", label: "5h", usedPercent: 42 },
        { kind: "window", label: "bad" }, // usedPercent missing
        { kind: "amount", label: "bad", unit: "not-a-unit", used: 1 },
        "not an object",
        { kind: "amount", label: "requests", unit: "requests", used: 1 },
      ],
      notes: ["kept", 42, null, { nested: true }],
    },
    open: false,
  });
  const decoded = decodeUsage(payload);
  expect(decoded?.report.metrics).toEqual([
    { kind: "window", label: "5h", usedPercent: 42 },
    { kind: "amount", label: "requests", unit: "requests", used: 1 },
  ]);
  expect(decoded?.report.notes).toEqual(["kept"]);
});

test("oversized metric and note arrays are bounded rather than iterated without limit", () => {
  const metrics = Array.from({ length: 200 }, (_, index) => ({
    kind: "amount",
    label: `m${index}`,
    unit: "requests",
    used: index,
  }));
  const notes = Array.from({ length: 200 }, (_, index) => `note ${index}`);
  const payload = JSON.stringify({ report: { ...report(), metrics, notes }, open: false });
  const decoded = decodeUsage(payload);
  expect(decoded?.report.metrics[0]?.label).toBe("m0");
  expect(decoded?.report.notes[0]).toBe("note 0");
  expect(decoded?.report.metrics.length).toBeLessThan(metrics.length);
  expect(decoded?.report.notes.length).toBeLessThan(notes.length);
});

test("oversized usage payloads are rejected", () => {
  const huge = JSON.stringify({ report: { ...report(), notes: ["x".repeat(130 * 1024)] }, open: false });
  expect(decodeUsage(huge)).toBeUndefined();
});
