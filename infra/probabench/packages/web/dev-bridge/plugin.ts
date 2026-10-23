// Development-only bridge: lets the page start and follow benchmark runs through the
// Vite dev server. The published site contains no runner or API secrets.
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import type { Plugin } from "vite";
import {
  BenchRequest,
  BRIDGE_ROUTES,
  type BridgeFailure,
  type BridgeStatus,
  firstIssue,
} from "../src/bridge/protocol";
import { createBenchController, RequestError } from "./controller";

/**
 * The CLI entry the infra shell's probabench runs, spawned directly so a cancel's SIGTERM
 * reaches the runner rather than a wrapper. Without --out the runner writes the
 * history file the page reads back, its DEFAULT_OUT.
 */
const RUNNER_ENTRY = "packages/runner/src/main.ts";
const MAX_BODY_BYTES = 4_096;
const decodeRequest = Schema.decodeEither(Schema.parseJson(BenchRequest));

/** Reject remote hosts and cross-site requests, including DNS rebinding to loopback. */
export function isLocalRequest(request: IncomingMessage, mutation: boolean): boolean {
  const host = request.headers.host;
  const address = request.socket.remoteAddress;
  if (!host || !address || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address))
    return false;
  try {
    const url = new URL(`http://${host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.host !== host)
      return false;
    const origin = request.headers.origin;
    if (mutation && origin !== url.origin) return false;
    if (origin && origin !== url.origin) return false;
    return request.headers["sec-fetch-site"] !== "cross-site";
  } catch {
    return false;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new RequestError(415, "Expected JSON run settings.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "Run settings are too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, code: number, body: BridgeStatus | BridgeFailure) {
  response.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function devBridgePlugin(): Plugin {
  const routes: readonly string[] = Object.values(BRIDGE_ROUTES);
  return {
    name: "probabench-dev-bridge",
    apply: "serve",
    configureServer(server) {
      // server.config.root is packages/web; the Bun workspace root holds the runner entry.
      const workspace = resolve(server.config.root, "../..");
      const controller = createBenchController({
        // `bun run dev` and `dev:alchemy` start Vite under sops exec-env with
        // secrets/infra/probabench.env.
        apiKey: process.env.OPENROUTER_API_KEY ?? "",
        launch: (args) =>
          spawn("bun", [RUNNER_ENTRY, ...args], {
            cwd: workspace,
            env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
          }),
      });
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        if (path === undefined || !routes.includes(path)) return next();
        if (!isLocalRequest(request, request.method !== "GET"))
          return send(response, 403, {
            error: "Only same-origin localhost requests can use the dev bridge.",
          });
        void (async () => {
          try {
            if (path === BRIDGE_ROUTES.status && request.method === "GET")
              return send(response, 200, controller.status());
            if (path === BRIDGE_ROUTES.run && request.method === "POST") {
              const decoded = decodeRequest(await readBody(request));
              if (Either.isLeft(decoded)) throw new RequestError(400, firstIssue(decoded.left));
              return send(response, 202, controller.start(decoded.right));
            }
            if (path === BRIDGE_ROUTES.cancel && request.method === "POST")
              return send(response, 200, controller.cancel());
            send(response, 405, { error: `${request.method} is not supported on ${path}.` });
          } catch (error) {
            send(response, error instanceof RequestError ? error.status : 500, {
              error:
                error instanceof RequestError
                  ? error.message
                  : "The dev bridge could not process this request.",
            });
          }
        })();
      });
      // A restart or exit closes the server; cancel the active run so no runner outlives it.
      server.httpServer?.once("close", () => controller.cancel());
    },
  };
}
