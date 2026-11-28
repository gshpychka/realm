import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { boot, click, normalMode, REPO, waitMatch } from "./helpers/harness.ts";
import { bootPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

async function clickCard(terminal: Parameters<typeof click>[0]): Promise<void> {
  const rows = (await terminal.text()).split("\n");
  const row = rows.findIndex((line) => line.includes(glyphs.card));
  assert.ok(row >= 0, "the footer's credit-card icon is visible");
  const prefix = rows[row]?.split(glyphs.card)[0];
  assert.ok(prefix !== undefined);
  await click(terminal, [...prefix].length, row);
}

for (const cols of [44, 120])
  test(`subscription usage and stale observations remain legible at ${cols} columns`, async () => {
    const app = await boot({
      entry: join(REPO, "packages/tui/src/components/provider-usage.fixture.tsx"),
      ready: "Provider usage preview",
      cols,
      rows: 36,
      env: { PITUITARY_STILL: "1" },
    });
    try {
      const ready = await app.capture(`usage-subscription-${cols}`);
      assert.match(ready, /88% used/);
      assert.match(ready, /12\.50/);
      await app.terminal.type("e");
      await app.terminal.waitText("Usage refresh failed.");
      const failed = await app.capture(`usage-stale-${cols}`);
      assert.match(failed, /88%/);
      assert.match(failed, /retry in/i);
      await app.terminal.type("r");
      await waitMatch(app.terminal, /^(?![\s\S]*Usage refresh failed)/);
      await clickCard(app.terminal);
      await waitMatch(app.terminal, /^(?![\s\S]*88%)/);
      const closed = await app.capture(`usage-subscription-closed-${cols}`);
      assert.match(closed, new RegExp(glyphs.card));
      assert.doesNotMatch(closed, /88%|63%|Extra usage|12\.50/);
    } finally {
      await app.close();
    }
  });

for (const cols of [44, 120])
  test(`provider usage opens, observes API limits, and closes at ${cols} columns`, async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests++;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "1m",
        });
        response.end(
          [
            {
              id: "chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Observed the API response." },
                  finish_reason: null,
                },
              ],
            },
            { id: "chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            "[DONE]",
          ]
            .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
            .join(""),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = server.address() as AddressInfo;
    let app: Awaited<ReturnType<typeof bootPi>> | undefined;
    try {
      app = await bootPi({
        auth: { openai: { type: "api_key", key: "fixture-secret" } },
        models: {
          providers: {
            openai: {
              baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
              api: "openai-completions",
              models: [{ id: "usage-fixture" }],
            },
          },
        },
        argv: ["--model", "openai/usage-fixture"],
        cols,
        rows: 36,
        ready: "usage-fixture",
      });
      await clickCard(app.terminal);
      await app.terminal.waitText("session estimate");
      assert.equal(requests, 0);
      const unavailable = await app.capture(`usage-unavailable-${cols}`);
      assert.match(unavailable, /usage unavailable/);
      assert.match(unavailable, /alt\+u \/ esc close/);
      await app.terminal.submit("inspect");
      await app.terminal.waitText("Observed the API response.");
      await app.terminal.waitIdle();
      const screen = await app.capture(`usage-api-${cols}`);
      assert.match(screen, /100/);
      assert.match(screen, /session estimate/);
      assert.doesNotMatch(screen, /fixture-secret|\{"report"/);
      assert.equal(requests, 1);
      await clickCard(app.terminal);
      await waitMatch(app.terminal, /^(?![\s\S]*session estimate)/);
      const closed = await app.capture(`usage-closed-${cols}`);
      assert.doesNotMatch(closed, /session estimate|Requests|remaining/);
      assert.match(closed, /usage-fixture/);
      // The keyboard opens the card too, and esc closes it once the draft leaves insert mode.
      await app.terminal.write("\x1bu");
      await app.terminal.waitText("session estimate");
      await normalMode(app.terminal);
      await app.terminal.keyboard.press("Escape");
      await waitMatch(app.terminal, /^(?![\s\S]*session estimate)/);
    } finally {
      await app?.close();
      server.close();
    }
  });
