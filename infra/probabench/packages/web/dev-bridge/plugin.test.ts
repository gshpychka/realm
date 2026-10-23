import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isLocalRequest } from "./plugin";

const request = (host: string, origin?: string, address = "127.0.0.1") =>
  ({
    headers: { host, ...(origin ? { origin } : {}) },
    socket: { remoteAddress: address },
  }) as IncomingMessage;

describe("isLocalRequest", () => {
  it("allows same-origin localhost mutations and local status reads", () => {
    expect(isLocalRequest(request("localhost:5173", "http://localhost:5173"), true)).toBe(true);
    expect(isLocalRequest(request("127.0.0.1:5173"), false)).toBe(true);
    expect(isLocalRequest(request("[::1]:5173", "http://[::1]:5173", "::1"), true)).toBe(true);
  });

  it("rejects remote callers, DNS rebinding, cross-site and missing-origin mutations", () => {
    expect(isLocalRequest(request("127.0.0.1:5173", "https://example.com"), true)).toBe(false);
    expect(isLocalRequest(request("evil.example:5173", "http://evil.example:5173"), true)).toBe(
      false,
    );
    expect(isLocalRequest(request("localhost:5173"), true)).toBe(false);
    expect(isLocalRequest(request("localhost:5173", undefined, "192.168.1.5"), false)).toBe(false);
    expect(isLocalRequest(request("localhost:5173@evil.example"), false)).toBe(false);
  });
});
