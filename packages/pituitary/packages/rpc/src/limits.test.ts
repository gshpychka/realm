import { describe, expect, test } from "bun:test";
import { limitHeaders, readLimits } from "./limits.ts";

const U = "anthropic-ratelimit-unified-";

describe("limitHeaders", () => {
  test("keeps only limit headers, lowercased", () => {
    expect(
      limitHeaders({
        "Anthropic-Ratelimit-Unified-Status": "allowed",
        "set-cookie": "x",
        "x-request-id": "y",
      }),
    ).toEqual({ [`${U}status`]: "allowed" });
  });

  test("drops values that are not strings or are overlong, and bounds the count", () => {
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`${U}w${index}-utilization`, "0.1"]),
    );
    expect(Object.keys(limitHeaders(many))).toHaveLength(64);
    expect(limitHeaders({ [`${U}status`]: 42, [`${U}reset`]: "9".repeat(300) })).toEqual({});
  });
});

describe("readLimits", () => {
  test("reads each window, the overall status, and the window that binds", () => {
    const limits = readLimits(
      {
        [`${U}status`]: "allowed_warning",
        [`${U}5h-utilization`]: "0.62",
        [`${U}5h-reset`]: "1900000000",
        [`${U}7d-utilization`]: "0.93",
        [`${U}7d-reset`]: "1900500000",
        [`${U}representative-claim`]: "seven_day",
      },
      123,
    );
    expect(limits).toEqual({
      status: "allowed_warning",
      binding: "7d",
      windows: [
        { id: "5h", utilization: 0.62, resetsAt: 1_900_000_000_000 },
        { id: "7d", utilization: 0.93, resetsAt: 1_900_500_000_000 },
      ],
      extra: null,
      receivedAt: 123,
    });
  });

  test("a window it has never heard of is read the same way", () => {
    const limits = readLimits({
      [`${U}7d_opus-utilization`]: "0.5",
      [`${U}representative-claim`]: "seven_day_opus",
    });
    expect(limits?.windows).toEqual([{ id: "7d_opus", utilization: 0.5, resetsAt: null }]);
    expect(limits?.binding).toBe("seven_day_opus");
  });

  test("extra usage is active while replies continue past a reached limit", () => {
    const limits = readLimits({
      [`${U}status`]: "rejected",
      [`${U}5h-utilization`]: "1",
      [`${U}overage-status`]: "allowed",
      [`${U}overage-period-monthly-utilization`]: "0.42",
      [`${U}overage-reset`]: "1900000000",
    });
    expect(limits?.extra).toEqual({
      status: "allowed",
      active: true,
      utilization: null,
      monthly: 0.42,
      resetsAt: 1_900_000_000_000,
      disabledReason: null,
    });
    expect(limits?.windows.map((window) => window.id)).toEqual(["5h"]);
  });

  test("extra usage in use is taken at its word", () => {
    const limits = readLimits({ [`${U}status`]: "allowed", [`${U}overage-in-use`]: "true" });
    expect(limits?.extra?.active).toBe(true);
  });

  test("low-priority budgets and grace allowances are not limit windows", () => {
    const limits = readLimits({
      [`${U}slow-budget-utilization`]: "0.5",
      [`${U}grace-5h-utilization`]: "0.5",
      [`${U}5h-utilization`]: "0.1",
    });
    expect(limits?.windows.map((window) => window.id)).toEqual(["5h"]);
  });

  test("garbage is skipped, never thrown", () => {
    const limits = readLimits({
      [`${U}status`]: "maybe",
      [`${U}5h-utilization`]: "lots",
      [`${U}5h-reset`]: "soon",
      [`${U}7d-utilization`]: "1.7",
      [`${U}7d-reset`]: "-5",
    });
    expect(limits?.status).toBeNull();
    expect(limits?.windows).toEqual([{ id: "7d", utilization: 1, resetsAt: null }]);
  });

  test("a response without limits reads as none", () => {
    expect(readLimits({ "content-type": "text/event-stream" })).toBeNull();
    expect(readLimits({ [`${U}5h-utilization`]: "" })).toBeNull();
  });
});
