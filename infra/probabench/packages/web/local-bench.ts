// Development-only bridge. The published site contains no runner or API secrets.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isModelToken, planBudget, ReasoningMode } from "@probabench/domain";
import * as Schema from "effect/Schema";
import { loadEnv, type Plugin } from "vite";

interface BenchRequest {
  readonly model: string;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
  readonly reasoning?: ReasoningMode;
}

export interface Job {
  readonly id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  log: string;
  error?: string;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_MODEL_LENGTH = 200;
const MAX_SAMPLES = 100_000;
const MAX_LOG = 64_000;

/** Suppress unfinished terminal escapes before normalizing a streamed log. */
function completeTerminalText(raw: string): string {
  for (let index = 0; index < raw.length; index++) {
    if (raw.charCodeAt(index) !== 27) continue;
    const start = index;
    const next = raw[++index];
    if (next === undefined) return raw.slice(0, start);
    if (next === "[") {
      // CSI: parameter/intermediate bytes end at the first final byte (@ through ~).
      while (++index < raw.length && !/[\u0040-\u007e]/.test(raw[index] ?? "")) {}
    } else if (next === "]") {
      // OSC: terminate at BEL or ST (ESC backslash).
      while (
        index < raw.length &&
        raw.charCodeAt(index) !== 7 &&
        !(raw.charCodeAt(index) === 27 && raw[index + 1] === "\\")
      )
        index++;
      if (raw.charCodeAt(index) === 27) index++;
    } else {
      while (index < raw.length && /[ -/]/.test(raw[index] ?? "")) index++;
    }
    if (index >= raw.length) return raw.slice(0, start);
  }
  return raw;
}

/** Bound browser requests before starting a process; the CLI also validates its own input. */
export function parseBenchRequest(value: unknown): BenchRequest {
  if (typeof value !== "object" || value === null)
    throw new RequestError(400, "Invalid run settings.");
  const request = value as Record<string, unknown>;
  const model = typeof request.model === "string" ? request.model.trim() : "";
  // Plain aliases and OpenRouter slugs only. Never interpolate any value into a shell.
  if (model.length > MAX_MODEL_LENGTH || !isModelToken(model)) {
    throw new RequestError(400, "Choose one model alias or OpenRouter vendor/model ID.");
  }
  const integer = (name: string, max: number): number => {
    const number = request[name];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > max) {
      throw new RequestError(400, `${name} must be an integer from 1 to ${max}.`);
    }
    return number;
  };
  const trialsPerStep = integer("trialsPerStep", 10_000);
  const stepPercent = integer("stepPercent", 100);
  const concurrency = integer("concurrency", 50);
  const reasoning = request.reasoning;
  if (reasoning !== undefined && !Schema.is(ReasoningMode)(reasoning)) {
    throw new RequestError(400, "Choose a valid reasoning setting.");
  }
  if (planBudget({ trialsPerStep, stepPercent }).samples > MAX_SAMPLES) {
    throw new RequestError(
      400,
      `A browser run supports up to ${MAX_SAMPLES.toLocaleString("en")} samples. Use the CLI for larger experiments.`,
    );
  }
  return {
    model,
    trialsPerStep,
    stepPercent,
    concurrency,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

interface ControllerOptions {
  readonly workspace: string;
  readonly apiKey: () => string;
  readonly launch?: (args: readonly string[], apiKey: string) => ChildProcess;
}

/** One local writer at a time; stopping the server also stops its active benchmark. */
export function createBenchController(options: ControllerOptions) {
  let job: Job | null = null;
  let child: ChildProcess | null = null;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const launch =
    options.launch ??
    ((args, apiKey) =>
      spawn("bun", [...args], {
        cwd: options.workspace,
        env: { ...process.env, OPENROUTER_API_KEY: apiKey, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      }));
  return {
    status: () => ({ local: true as const, configured: options.apiKey().trim().length > 0, job }),
    start(value: unknown): Job {
      const settings = parseBenchRequest(value);
      if (child) throw new RequestError(409, "A benchmark is already running or stopping.");
      const apiKey = options.apiKey().trim();
      if (!apiKey)
        throw new RequestError(400, "Add OPENROUTER_API_KEY to .env.local, then try again.");
      const current: Job = {
        id: randomUUID(),
        status: "running",
        startedAt: new Date().toISOString(),
        log: "",
      };
      const processHandle = launch(
        [
          "packages/runner/src/main.ts",
          "--model",
          settings.model,
          "--trials",
          String(settings.trialsPerStep),
          "--step",
          String(settings.stepPercent),
          "--concurrency",
          String(settings.concurrency),
          ...(settings.reasoning === undefined ? [] : ["--reasoning", settings.reasoning]),
          "--yes",
        ],
        apiKey,
      );
      child = processHandle;
      stopping = false;
      job = current;
      let rawLog = "";
      const append = (chunk: string) => {
        rawLog = (rawLog + chunk).slice(-(MAX_LOG * 2));
        let text = stripVTControlCharacters(completeTerminalText(rawLog))
          .split(apiKey)
          .join("[redacted]");
        // A secret may straddle arbitrary pipe chunks. Hold any unfinished prefix
        // until the next chunk, including when the browser polls between them.
        let held = 0;
        for (let length = 1; length < apiKey.length; length++) {
          if (text.endsWith(apiKey.slice(0, length))) held = length;
        }
        if (held > 0) text = text.slice(0, -held);
        current.log = text.slice(-MAX_LOG);
      };
      processHandle.stdout?.setEncoding("utf8").on("data", append);
      processHandle.stderr?.setEncoding("utf8").on("data", append);
      processHandle.on("error", () => {
        current.error =
          "Could not start Bun. Run this page from the Realm infra development shell.";
      });
      processHandle.once("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        current.status = stopping ? "cancelled" : code === 0 ? "completed" : "failed";
        if (current.status === "failed" && !current.error) {
          current.error = "The benchmark stopped before completing. See the run log for details.";
        }
        child = null;
      });
      return current;
    },
    cancel(): Job | null {
      if (child && !stopping) {
        stopping = true;
        const active = child;
        active.kill("SIGTERM");
        // A stuck provider request must not leave a paid run alive indefinitely.
        killTimer = setTimeout(() => active.kill("SIGKILL"), 3_000);
        killTimer.unref();
      }
      return job;
    },
  };
}

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

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new RequestError(415, "Expected JSON run settings.");
  }
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 4_096) throw new RequestError(413, "Run settings are too large.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new RequestError(400, "Invalid JSON run settings.");
  }
}

function send(response: ServerResponse, code: number, body: unknown) {
  response.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export function localBenchPlugin(): Plugin {
  let controller: ReturnType<typeof createBenchController> | undefined;
  return {
    name: "probabench-local-runner",
    apply: "serve",
    configureServer(server) {
      const workspace = resolve(server.config.root, "../..");
      controller = createBenchController({
        workspace,
        // Reload per request so adding .env.local needs no restart. Never VITE_-prefix secrets.
        apiKey: () =>
          loadEnv(server.config.mode, workspace, "OPENROUTER_").OPENROUTER_API_KEY ?? "",
      });
      const runner = controller;
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        if (!path?.startsWith("/api/bench/")) return next();
        if (!isLocalRequest(request, request.method !== "GET"))
          return send(response, 403, {
            error: "Only same-origin localhost requests can access the local runner.",
          });
        void (async () => {
          try {
            if (path === "/api/bench/status" && request.method === "GET")
              return send(response, 200, runner.status());
            if (path === "/api/bench/run" && request.method === "POST")
              return send(response, 202, runner.start(await readBody(request)));
            if (path === "/api/bench/cancel" && request.method === "POST")
              return send(response, 200, runner.cancel());
            send(response, 404, { error: "Unknown local runner endpoint." });
          } catch (error) {
            send(response, error instanceof RequestError ? error.status : 500, {
              error:
                error instanceof RequestError
                  ? error.message
                  : "The local runner could not process this request.",
            });
          }
        })();
      });
      server.httpServer?.once("close", () => runner.cancel());
    },
    closeBundle() {
      controller?.cancel();
    },
  };
}
