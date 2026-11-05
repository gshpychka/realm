import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionEvent } from "@pituitary/session";
import { PiConversation, type PiUiRequest } from "./pi.ts";
import { resolveUsage } from "./pi-usage.ts";
import { decodeUsage } from "./usage/presentation.ts";
import { USAGE_STATUS } from "./usage/types.ts";

function context(provider = "openai", oauth = false, baseUrl = "https://api.openai.com/v1") {
  return {
    model: { provider, id: "test", baseUrl },
    modelRegistry: {
      isUsingOAuth: () => oauth,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-secret" }),
    },
  } as unknown as ExtensionContext;
}

test("credential resolution uses Pi's auth and restricts account polling to official hosts", async () => {
  const direct = context("openai", true);
  expect(await resolveUsage(direct)).toMatchObject({
    provider: "openai",
    auth: "subscription",
    state: "unavailable",
  });
  expect(await resolveUsage(context("openai-codex", true, "https://chatgpt.com/backend-api"))).toMatchObject({
    provider: "openai",
    auth: "subscription",
    token: "fixture-secret",
  });
  for (const url of [
    "http://api.openai.com/v1",
    "https://api.openai.com.evil/v1",
    "https://api.openai.com:444/v1",
  ])
    expect(await resolveUsage(context("openai-codex", true, url))).toMatchObject({ state: "unavailable" });
  expect(await resolveUsage(context("openrouter", false, "http://localhost:3000/v1"))).toMatchObject({
    state: "unavailable",
  });
  expect(await resolveUsage(context("openai", false, "http://localhost:3000/v1"))).toMatchObject({
    auth: "api",
    token: "fixture-secret",
  });
});

test("Claude subscription tokens in API-key configuration keep subscription semantics", async () => {
  const ctx = context("anthropic", false, "https://api.anthropic.com");
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "sk-ant-oat-fixture" });
  expect(await resolveUsage(ctx)).toMatchObject({ auth: "subscription", token: "sk-ant-oat-fixture" });
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({
    ok: true,
    headers: { Authorization: "Bearer sk-ant-oat-fixture" },
    baseUrl: "http://localhost:3000",
  });
  expect(await resolveUsage(ctx)).toMatchObject({ auth: "subscription", state: "unavailable" });
});

test("credential errors stay private and ChatGPT usage routes to the token's account", async () => {
  const ctx = context("openai-codex", true);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "secret error body" });
  const result = await resolveUsage(ctx);
  expect(result).toMatchObject({ state: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("secret");
  const token = `head.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url")}.signature`;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token });
  expect(await resolveUsage(ctx)).toMatchObject({ accountId: "account-1" });
});

const PI = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "bundle/cli.js",
);
const EXTENSION = fileURLToPath(new URL("./pi-usage.ts", import.meta.url));
let home: string;
let server: ReturnType<typeof Bun.serve>;
let requests = 0;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pituitary-usage-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests++;
      await request.json();
      return new Response(
        [
          {
            id: "chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "observed" }, finish_reason: null }],
          },
          { id: "chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ]
          .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-ratelimit-limit-requests": "100",
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-reset-requests": "1m",
          },
        },
      );
    },
  });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "fixture-secret" } }),
  );
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: "openai-completions",
          models: [{ id: "fixture" }],
        },
      },
    }),
  );
});
afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

test("native Pi reports observed API limits and /usage controls display without a model request", async () => {
  const pi = new PiConversation({
    command: "node",
    args: [PI, "--no-extensions", "--no-skills", "--extension", EXTENSION, "--model", "openai/fixture"],
    cwd: home,
    env: { PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  const statuses: PiUiRequest[] = [];
  const events: SessionEvent[] = [];
  pi.onRequest((request) => statuses.push(request));
  pi.onEvent((event) => events.push(event));
  const display = () => {
    const status = statuses.findLast(
      (request) => request.method === "setStatus" && request.statusKey === USAGE_STATUS,
    );
    return status?.method === "setStatus" ? decodeUsage(status.statusText) : undefined;
  };
  try {
    await pi.getState();
    await until(() => display()?.report.state === "unavailable");
    const before = requests;
    await pi.prompt("/usage");
    expect(display()?.open).toBe(true);
    expect(requests).toBe(before);
    await pi.prompt("inspect");
    await until(() => events.some((event) => event.type === "agent_settled"));
    expect(display()?.report).toMatchObject({ state: "ready", auth: "api", metrics: [{ remaining: 0 }] });
    expect(requests).toBe(before + 1);
    await pi.prompt("/usage off");
    expect(display()?.open).toBe(false);
    expect(JSON.stringify(statuses)).not.toContain("fixture-secret");
    await pi.request({ type: "new_session" });
    await until(() => display()?.report.state === "unavailable");
    expect(display()?.open).toBe(false);
    expect(display()?.report.metrics).toEqual([]);
  } finally {
    await pi.close();
  }
}, 30_000);

async function until(done: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("usage status timed out");
    await Bun.sleep(20);
  }
}
