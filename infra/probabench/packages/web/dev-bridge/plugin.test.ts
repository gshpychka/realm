import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { BRIDGE_ROUTES, type BridgeStatus } from "../src/bridge/protocol";
import type { BenchController } from "./controller";
import { bridgeMiddleware, isLocalRequest } from "./plugin";

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
    ["a same-origin POST", { method: "POST", origin: "http://localhost:5173" }],
    ["a status read without Origin", { host: "127.0.0.1:5173" }],
    [
      "an IPv6 loopback POST",
      { host: "[::1]:5173", origin: "http://[::1]:5173", address: "::1", method: "POST" },
    ],
  ])("allows %s", (_, fields) => {
    expect(isLocalRequest(fakeRequest(fields))).toBe(true);
  });

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

interface Call {
  readonly method?: string;
  readonly path: string;
  readonly body?: string;
  readonly origin?: string;
}

interface Reply {
  readonly status: number | undefined;
  readonly body: string;
}

describe("bridgeMiddleware", () => {
  const idle: BridgeStatus = { configured: true, job: null };
  const stub: BenchController = { status: () => idle, start: () => idle, cancel: () => idle };
  const server = createServer((request, response) =>
    bridgeMiddleware(stub)(request, response, () => response.writeHead(404).end()),
  );
  let host = "";
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** node:http rather than fetch, so the test can set Origin freely. */
  const send = ({ method = "GET", path, body = "", origin }: Call) =>
    new Promise<Reply>((resolve, reject) => {
      const outgoing = httpRequest(`http://${host}${path}`, {
        method,
        headers: { origin: origin ?? `http://${host}` },
      });
      outgoing.on("response", (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, body: text }));
      });
      outgoing.on("error", reject);
      outgoing.end(body);
    });

  const run = (body: string): Call => ({ method: "POST", path: BRIDGE_ROUTES.run, body });
  const valid = { model: "vendor/model", trialsPerStep: 10, stepPercent: 25, concurrency: 5 };

  it.each<[string, Call, number]>([
    ["a status read", { path: BRIDGE_ROUTES.status }, 200],
    ["a valid run", run(JSON.stringify(valid)), 202],
    ["oversized run settings", run("x".repeat(5_000)), 413],
    ["an unsupported method", { method: "PUT", path: BRIDGE_ROUTES.status }, 405],
    ["a cross-site cancel", { method: "POST", path: BRIDGE_ROUTES.cancel, origin: "null" }, 403],
    ["any other path", { path: "/index.html" }, 404],
  ])("answers %s with %i", async (_, call, status) => {
    expect((await send(call)).status).toBe(status);
  });

  it("names the first problem in invalid run settings", async () => {
    const response = await send(run("{}"));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "model: is missing" });
  });
});
