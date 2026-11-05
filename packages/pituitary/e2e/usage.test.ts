import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { boot, click, REPO, waitMatch } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

const PI = join(REPO, "packages/tui/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

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
    const home = realpathSync(mkdtempSync("/tmp/pituitary-usage-e2e-"));
    const agent = join(home, ".pi", "agent");
    const cwd = join(home, "sample");
    mkdirSync(agent, { recursive: true });
    mkdirSync(cwd);
    const endpoint = server.address() as AddressInfo;
    writeFileSync(
      join(agent, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "fixture-secret" } }),
    );
    writeFileSync(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
            api: "openai-completions",
            models: [{ id: "usage-fixture" }],
          },
        },
      }),
    );
    let app: Awaited<ReturnType<typeof boot>> | undefined;
    try {
      app = await boot({
        entry: join(REPO, "packages/tui/src/main.tsx"),
        argv: ["--model", "openai/usage-fixture"],
        cwd,
        cols,
        rows: 36,
        ready: "usage-fixture",
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
      await clickCard(app.terminal);
      await app.terminal.waitText("session estimate");
      assert.equal(requests, 0);
      assert.match(await app.capture(`usage-unavailable-${cols}`), /usage unavailable/);
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
    } finally {
      await app?.close();
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
