import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type { ReactNode } from "react";
import type { UsageReport } from "../usage/types.ts";
import { UsagePanel } from "./provider-usage.tsx";

const NOW = 1_700_000_000_000;

function report(partial: Partial<UsageReport> = {}): UsageReport {
  return {
    provider: "anthropic",
    auth: "subscription",
    model: "claude",
    state: "ready",
    plan: "Max",
    checkedAt: NOW,
    metrics: [
      { kind: "window", label: "5h", usedPercent: 42, resetsAt: NOW + 2 * 60 * 60 * 1000 },
      { kind: "amount", label: "requests", unit: "requests", used: 128, limit: 1000 },
    ],
    notes: ["billed monthly"],
    ...partial,
  };
}

async function draw(view: ReactNode, width: number, height: number) {
  const app = await createTestRenderer({ width, height });
  const root = createRoot(app.renderer);
  flushSync(() => root.render(view));
  await app.renderOnce();
  return {
    frame: app.captureCharFrame(),
    close() {
      flushSync(() => root.unmount());
      app.renderer.destroy();
    },
  };
}

/** The frame's rows joined by spaces, so a word wrapped across lines still reads as one phrase. */
function flatten(frame: string): string {
  return frame.split("\n").join(" ").replace(/\s+/g, " ").trim();
}

test("a stale ready report (aged past two minutes) marks itself without an error", async () => {
  const stale = report({ checkedAt: NOW - 121_000 });
  const { frame, close } = await draw(<UsagePanel report={stale} now={NOW} />, 100, 20);
  try {
    expect(flatten(frame)).toContain("stale");
  } finally {
    close();
  }
});

test("a passed reset on a later metric marks the report stale without renewing its allowance", async () => {
  const expired = report({
    metrics: [
      { kind: "window", label: "5h", usedPercent: 42, resetsAt: NOW + 60_000 },
      { kind: "amount", label: "Credits", unit: "credits", remaining: 10, resetsAt: NOW - 1 },
    ],
  });
  const { frame, close } = await draw(<UsagePanel report={expired} now={NOW} />, 100, 20);
  try {
    const flat = flatten(frame);
    expect(flat).toContain("stale");
    expect(flat).toContain("remaining 10.00 credits");
    expect(flat).toContain("reset passed · awaiting refresh");
  } finally {
    close();
  }
});

for (const width of [40, 120])
  test(`every figure stays whole at ${width} columns, wrapped rather than clipped`, async () => {
    const { frame, close } = await draw(
      <UsagePanel report={report()} now={NOW} sessionCost={12.3456} />,
      width,
      24,
    );
    try {
      const flat = flatten(frame);
      expect(flat).toContain("Anthropic · sub · claude · Max");
      expect(flat).toContain("42% used · resets in 2h 0m");
      expect(flat).toContain("used 128 requests · limit 1000 requests");
      expect(flat).toContain("billed monthly");
      expect(flat).toContain("session estimate $12.35 · not account billing");
    } finally {
      close();
    }
  });

test("large usage reports keep the expanded panel bounded", async () => {
  const many = report({
    metrics: Array.from({ length: 20 }, (_, index) => ({
      kind: "amount" as const,
      label: `metric-${index}`,
      unit: "requests" as const,
      used: index,
    })),
    notes: [],
  });
  const { frame, close } = await draw(<UsagePanel report={many} now={NOW} />, 80, 100);
  try {
    expect(frame).toContain("metric-0");
    expect(frame).not.toContain("metric-19");
  } finally {
    close();
  }
});
