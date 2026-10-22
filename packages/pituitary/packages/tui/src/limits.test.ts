import { describe, expect, test } from "bun:test";
import type { Limits } from "@pituitary/rpc";
import {
  currentWindows,
  extraShown,
  extraTone,
  until,
  untilShort,
  usageReport,
  windowName,
  windowShort,
  windowTone,
} from "./limits.ts";

const NOW = 1_900_000_000_000;
const HOUR = 3_600_000;

const limits = (patch: Partial<Limits> = {}): Limits => ({
  status: "allowed",
  binding: "5h",
  windows: [
    { id: "5h", utilization: 0.34, resetsAt: NOW + 3 * HOUR },
    { id: "7d", utilization: 0.12, resetsAt: NOW + 96 * HOUR },
  ],
  extra: null,
  receivedAt: NOW,
  ...patch,
});

describe("windowName", () => {
  test("names windows in words", () => {
    expect(windowName("5h")).toBe("five-hour");
    expect(windowName("7d")).toBe("weekly");
    expect(windowName("7d_opus")).toBe("seven-day opus");
    expect(windowName("30d")).toBe("30-day");
    expect(windowName("monthly_cap")).toBe("monthly cap");
  });
});

describe("windowTone", () => {
  test("warns past 70% and alarms past 90%", () => {
    const at = (utilization: number) => windowTone({ id: "7d", utilization, resetsAt: null }, limits());
    expect(at(0.5)).toBe("calm");
    expect(at(0.7)).toBe("warn");
    expect(at(0.9)).toBe("alarm");
  });

  test("the binding window takes Anthropic's warning and rejection", () => {
    const window = { id: "5h", utilization: 0.2, resetsAt: null };
    expect(windowTone(window, limits({ status: "allowed_warning" }))).toBe("warn");
    expect(windowTone(window, limits({ status: "rejected" }))).toBe("alarm");
    expect(windowTone({ ...window, id: "7d" }, limits({ status: "rejected" }))).toBe("calm");
  });
});

test("a window whose reset has passed is no longer current", () => {
  const read = limits({ windows: [{ id: "5h", utilization: 0.9, resetsAt: NOW - 1 }] });
  expect(currentWindows(read, NOW)).toEqual([]);
});

test("until reads in words", () => {
  expect(until(NOW + 45 * 60_000, NOW)).toBe("in 45 minutes");
  expect(until(NOW + HOUR, NOW)).toBe("in 1 hour");
  expect(until(NOW + 50 * HOUR, NOW)).toBe("in 2 days");
  expect(until(NOW + 10_000, NOW)).toBe("in under a minute");
});

describe("extra usage", () => {
  const extra = {
    status: "allowed" as const,
    active: false,
    utilization: null,
    monthly: null,
    resetsAt: null,
    disabledReason: null,
  };

  test("shows while in use or once the month has spent some", () => {
    expect(extraShown(limits({ extra }))).toBe(false);
    expect(extraShown(limits({ extra: { ...extra, active: true } }))).toBe(true);
    expect(extraShown(limits({ extra: { ...extra, monthly: 0.1 } }))).toBe(true);
  });

  test("warns while in use and alarms at its cap", () => {
    expect(extraTone(limits({ extra: { ...extra, monthly: 0.1 } }))).toBe("calm");
    expect(extraTone(limits({ extra: { ...extra, active: true } }))).toBe("warn");
    expect(extraTone(limits({ extra: { ...extra, status: "rejected" } }))).toBe("alarm");
  });
});

describe("usageReport", () => {
  test("lists every window with its reset and marks the one that applies", () => {
    const report = usageReport(limits(), NOW);
    expect(report).toContain("five-hour  34% used · resets in 3 hours · the limit that applies now");
    expect(report).toContain("weekly     12% used · resets in 4 days");
    expect(report).toContain("Spend in dollars is on the usage page of claude.ai's settings.");
  });

  test("says how much extra usage has spent, and why it is off", () => {
    const report = usageReport(
      limits({
        extra: {
          status: "rejected",
          active: false,
          utilization: null,
          monthly: 0.42,
          resetsAt: NOW + 24 * HOUR,
          disabledReason: "out_of_credits",
        },
      }),
      NOW,
    );
    expect(report).toContain("42% of this month's spending cap is spent.");
    expect(report).toContain("Anthropic gives the reason: out of credits.");
  });

  test("explains when nothing has been reported", () => {
    expect(usageReport(null)).toContain("No usage limits reported yet");
  });
});

describe("windowShort", () => {
  test("names windows by their span, the weekly one as wk", () => {
    expect(windowShort("5h")).toBe("5h");
    expect(windowShort("7d")).toBe("wk");
    expect(windowShort("7d_opus")).toBe("wk opus");
    expect(windowShort("7d_oi")).toBe("wk+extra");
    expect(windowShort("30d")).toBe("30d");
    expect(windowShort("monthly_cap")).toBe("monthly cap");
  });
});

describe("untilShort", () => {
  test("reads in the largest whole unit", () => {
    expect(untilShort(NOW + 20_000, NOW)).toBe("1m");
    expect(untilShort(NOW + 0.7 * HOUR, NOW)).toBe("42m");
    expect(untilShort(NOW + 3 * HOUR, NOW)).toBe("3h");
    expect(untilShort(NOW + 80 * HOUR, NOW)).toBe("3d");
  });
});
