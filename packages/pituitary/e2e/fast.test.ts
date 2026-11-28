import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { waitMatch } from "./helpers/harness.ts";
import { bootPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

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
  const app = await bootPi({
    auth: {
      openai: { type: "oauth", access: "chatgpt-fixture", refresh: "fixture", expires: Date.now() + 864e5 },
    },
    models: { providers: { openai: { baseUrl: `http://127.0.0.1:${endpoint.port}/v1` } } },
    argv: ["--model", "openai/gpt-6.1-sol"],
    // The footer names the model as Pi's registry does.
    ready: "GPT-6.1 Sol",
  });
  try {
    assert.doesNotMatch(await app.terminal.text(), new RegExp(BOLT));
    await app.terminal.type("/fa");
    await app.terminal.waitText("answer faster on ChatGPT models");
    await app.capture("fast-command");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, new RegExp(`GPT-6\\.1 Sol ${BOLT}`));
    await app.terminal.submit("hurry");
    await app.terminal.waitText("Answered at priority.");
    await app.terminal.waitIdle();
    const screen = await app.capture("fast-on");
    assert.match(screen, new RegExp(`GPT-6\\.1 Sol ${BOLT}`));
    assert.deepEqual(
      bodies.map((body) => body.service_tier),
      ["priority"],
    );
    await app.terminal.submit("/fast");
    await waitMatch(app.terminal, new RegExp(`GPT-6\\.1 Sol(?! ${BOLT})`));
    await app.capture("fast-off");
  } finally {
    await app.close();
  }
}
