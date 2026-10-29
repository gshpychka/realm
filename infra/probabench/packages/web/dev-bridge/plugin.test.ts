import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { isLocalRequest } from "./plugin";

interface RequestFields {
  readonly host?: string;
  readonly origin?: string;
  readonly address?: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
}

const fakeRequest = ({
  host = "localhost:5173",
  origin,
  address = "127.0.0.1",
  method = "GET",
  headers = {},
}: RequestFields) =>
  ({
    method,
    headers: { host, ...(origin ? { origin } : {}), ...headers },
    socket: { remoteAddress: address },
  }) as IncomingMessage;

describe("isLocalRequest", () => {
  it.each<[string, RequestFields]>([
    ["a foreign-Origin POST", { method: "POST", origin: "https://example.com" }],
    [
      "DNS rebinding",
      { method: "POST", host: "evil.example:5173", origin: "http://evil.example:5173" },
    ],
    ["a POST without Origin", { method: "POST" }],
    ["a remote peer", { address: "192.168.1.5" }],
    ["userinfo in Host", { host: "localhost:5173@evil.example" }],
    ["a cross-origin status read", { origin: "https://example.com" }],
    ["a cross-site fetch", { headers: { "sec-fetch-site": "cross-site" } }],
  ])("rejects %s", (_, fields) => {
    expect(isLocalRequest(fakeRequest(fields))).toBe(false);
  });
});
