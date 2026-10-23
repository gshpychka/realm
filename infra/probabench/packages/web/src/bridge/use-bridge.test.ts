import { describe, expect, it } from "@effect/vitest";
import type { BridgeStatus, Job } from "./protocol";
import { type Connection, nextConnection, nextDelay, POLL_MS } from "./use-bridge";

const job = (status: Job["status"]): Job => ({
  id: "job",
  status,
  startedAt: "2026-10-22T10:00:00.000Z",
  log: "",
  progress: null,
});
const idle: BridgeStatus = { configured: true, job: null };
const running: BridgeStatus = { configured: true, job: job("running") };
const local = (status: BridgeStatus, reconnecting = false): Connection => ({
  kind: "local",
  status,
  reconnecting,
});

describe("nextConnection", () => {
  it("goes local on the first status", () => {
    expect(nextConnection({ kind: "connecting" }, idle)).toEqual(local(idle));
  });

  it("keeps connecting while the bridge has not answered yet", () => {
    expect(nextConnection({ kind: "connecting" }, null)).toEqual({ kind: "connecting" });
  });

  it("keeps the last status and marks it reconnecting when a poll fails", () => {
    expect(nextConnection(local(running), null)).toEqual(local(running, true));
  });

  it("clears reconnecting once the bridge answers again", () => {
    expect(nextConnection(local(running, true), idle)).toEqual(local(idle));
  });
});

describe("nextDelay", () => {
  it.each([
    [{ kind: "published" } as const, null],
    [{ kind: "connecting" } as const, POLL_MS.retry],
    [local(running, true), POLL_MS.retry],
    [local(running), POLL_MS.running],
    [local(idle), POLL_MS.idle],
    [local({ configured: true, job: job("completed") }), POLL_MS.idle],
  ])("schedules %j: %s", (connection, delay) => {
    expect(nextDelay(connection)).toBe(delay);
  });
});
