import { describe, expect, it } from "@effect/vitest";
import type { BridgeStatus } from "./protocol";
import { type Connection, nextConnection } from "./use-bridge";

const idle: BridgeStatus = { configured: true, job: null };
const running: BridgeStatus = {
  configured: true,
  job: {
    id: "job",
    status: "running",
    startedAt: "2026-10-22T10:00:00.000Z",
    log: "",
    progress: null,
  },
};
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
