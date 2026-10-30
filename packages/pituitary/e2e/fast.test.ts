import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { boot, REPO, waitMatch } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

const PI = join(REPO, "packages/tui/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const BOLT = "\u{f140b}";
const item = { type: "message", id: "msg", role: "assistant" };
const REPLY = [
  { type: "response.created", response: { id: "resp", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { ...item, content: [{ type: "output_text", text: "Answered at priority." }] },
  },
  {
    type: "response.completed",
    response: { id: "resp", status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
  },
];

test("/fast marks the ChatGPT model in the footer and asks the provider for priority", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(REPLY.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await converse(server.address() as AddressInfo, bodies);
  } finally {
    server.close();
  }
});

async function converse(endpoint: AddressInfo, bodies: Record<string, unknown>[]) {
  // Regular Pi signs in to ChatGPT with a placeholder credential and answers from the local endpoint.
  const home = realpathSync(mkdtempSync("/tmp/pituitary-fast-"));
  const agent = join(home, ".pi", "agent");
  const cwd = join(home, "sample");
  mkdirSync(agent, { recursive: true });
  mkdirSync(cwd);
  writeFileSync(
    join(agent, "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "chatgpt-fixture", refresh: "fixture", expires: Date.now() + 864e5 },
    }),
  );
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: { openai: { baseUrl: `http://127.0.0.1:${endpoint.port}/v1` } },
    }),
  );
  const app = await boot({
    entry: join(REPO, "packages/tui/src/main.tsx"),
    argv: ["--model", "openai/gpt-6.1-sol"],
    cwd,
    ready: "gpt-6.1-sol",
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_AGENT_CMD: "node",
      PI_AGENT_ARGS: `${PI} --no-extensions --no-skills`,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PITUITARY_STILL: "1",
      PITUITARY_GH: "",
      PITUITARY_LOG: join(home, "tui.log"),
    },
  });
  try {
    assert.doesNotMatch(await app.terminal.text(), new RegExp(BOLT));
    await app.terminal.type("/fa");
    await app.terminal.waitText("answer faster on ChatGPT models");
    await app.capture("fast-command");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, new RegExp(`gpt-6\\.1-sol ${BOLT}`));
    await app.terminal.submit("hurry");
    await app.terminal.waitText("Answered at priority.");
    await app.terminal.waitIdle();
    const screen = await app.capture("fast-on");
    assert.match(screen, new RegExp(`gpt-6\\.1-sol ${BOLT}`));
    assert.deepEqual(
      bodies.map((body) => body.service_tier),
      ["priority"],
    );
    await app.terminal.submit("/fast");
    await waitMatch(app.terminal, new RegExp(`gpt-6\\.1-sol(?! ${BOLT})`));
    await app.capture("fast-off");
  } finally {
    await app.close();
  }
}
