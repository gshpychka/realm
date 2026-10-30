import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@pituitary/session";
import { PiConversation, type PiUiRequest } from "./pi.ts";
import { FAST_STATUS } from "./pi-fast.ts";

const PI = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "bundle/cli.js",
);
const EXTENSION = fileURLToPath(new URL("./pi-fast.ts", import.meta.url));

const item = { type: "message", id: "msg", role: "assistant" };
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const RESPONSES = [
  { type: "response.created", response: { id: "resp", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { ...item, content: [{ type: "output_text", text: "ok" }] },
  },
  { type: "response.completed", response: { id: "resp", status: "completed", usage, output: [] } },
].map((event) => JSON.stringify(event));
const COMPLETIONS = [
  ...[
    {
      id: "chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    { id: "chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ].map((event) => JSON.stringify(event)),
  "[DONE]",
];

/** Provider requests answered by a local endpoint; the pinned Pi signs in with a placeholder ChatGPT credential. */
let home: string;
let server: ReturnType<typeof Bun.serve>;
const bodies: Record<string, unknown>[] = [];
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "pituitary-fast-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push((await request.json()) as Record<string, unknown>);
      const events = new URL(request.url).pathname.endsWith("/responses") ? RESPONSES : COMPLETIONS;
      return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}/v1`;
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "chatgpt-fixture", refresh: "fixture", expires: Date.now() + 864e5 },
    }),
  );
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        openai: { baseUrl: endpoint },
        local: { baseUrl: endpoint, api: "openai-completions", apiKey: "fixture", models: [{ id: "plain" }] },
      },
    }),
  );
  writeFileSync(join(home, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
});
afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

function start(...args: string[]) {
  const client = new PiConversation({
    command: "node",
    args: [PI, "--no-extensions", "--no-skills", "--extension", EXTENSION, ...args],
    cwd: home,
    env: { PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  const requests: PiUiRequest[] = [];
  client.onRequest((request) => requests.push(request));
  const events: SessionEvent[] = [];
  client.onEvent((event) => events.push(event));
  const fast = () =>
    requests.findLast((request) => request.method === "setStatus" && request.statusKey === FAST_STATUS);
  return {
    client,
    requests,
    /** The status text Pituitary draws as the footer's Fast mark. */
    fast: () => (fast() as { statusText?: string } | undefined)?.statusText,
    /** The provider request body a prompt sends, once its run settles. */
    async ask(text: string) {
      const from = bodies.length,
        settled = events.length;
      await client.prompt(text);
      await until(() => events.slice(settled).some((event) => event.type === "agent_settled"));
      return bodies[from];
    },
  };
}

async function until(done: () => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

test("Fast mode asks ChatGPT for priority, follows the model, and stays with its conversation", async () => {
  const pi = start("--model", "openai/gpt-6.1-sol");
  let resumed: ReturnType<typeof start> | undefined;
  try {
    await pi.client.getState();
    expect(pi.fast()).toBeUndefined();
    expect((await pi.ask("standard"))?.service_tier).toBeUndefined();

    await pi.client.prompt("/fast");
    expect(pi.fast()).toBe("fast");
    expect(await pi.ask("hurry")).toMatchObject({ model: "gpt-6.1-sol", service_tier: "priority" });

    await pi.client.call({ type: "set_model", provider: "local", modelId: "plain" });
    expect(pi.fast()).toBeUndefined();
    expect((await pi.ask("elsewhere"))?.service_tier).toBeUndefined();
    await pi.client.prompt("/fast on");
    expect(pi.requests.at(-1)).toMatchObject({ method: "notify", notifyType: "warning" });
    await pi.client.call({ type: "set_model", provider: "openai", modelId: "gpt-6.1-sol" });
    expect(pi.fast()).toBe("fast");

    const { sessionFile } = await pi.client.getState();
    await pi.client.close();
    resumed = start("--session", sessionFile as string);
    await resumed.client.getState();
    await until(() => resumed?.fast() === "fast");
    expect((await resumed.ask("resumed"))?.service_tier).toBe("priority");

    await resumed.client.request({ type: "new_session" });
    expect(resumed.fast()).toBeUndefined();
    expect((await resumed.ask("a new conversation"))?.service_tier).toBeUndefined();
  } finally {
    await pi.client.close();
    await resumed?.client.close();
  }
}, 60000);
