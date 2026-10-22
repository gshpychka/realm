import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, normalMode, pastGrace } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const CTRL_O = "\x0f";

after(async () => {
  await closeAll();
});

for (const delayMs of [100, 200])
  test(`keys typed as a dialog opens do not answer it (${delayMs}ms events)`, async () => {
    const app = await launch({ scenario: "permission", delayMs });
    try {
      await app.terminal.submit("clean up");
      await app.terminal.waitText("rm -rf build");
      await app.terminal.submit("no stop");
      // The tool's heading precedes the ask by several events. Wait for the actual
      // dialog after typing, then verify it remains unanswered past its grace period.
      await app.terminal.waitText("Yes, for this session", { timeout: 2000 });
      await pastGrace();
      await app.terminal.waitIdle();
      const screen = await app.capture("dialog-grace");
      assert.match(screen, /Yes, for this session/, `the dialog was answered by typing:\n${screen}`);
      assert.doesNotMatch(screen, /Removed build/, screen);
      await app.terminal.write("\x1b[B\x1b[B\r");
      await app.terminal.waitText("Left build alone (No)");
    } finally {
      await app.close();
    }
  });

test("escape sequences from the model, a tool, or an extension never reach the terminal", async () => {
  const app = await launch({ scenario: "hostile" });
  const before = await app.terminal.getTitle();
  await app.terminal.submit("go");
  await app.terminal.waitText("notice done");
  // The reply's words went on to a tool call, so they sit in the run's box with its output.
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("still here");
  const screen = await app.capture("hostile");
  assert.match(screen, /▌ go/, `the screen was cleared:\n${screen}`);
  assert.match(screen, /notice done/, screen);
  assert.match(screen, /line.*end/, screen);
  assert.doesNotMatch(
    String((await app.terminal.getTitle()) ?? ""),
    /PWNED/,
    "a title escape reached the terminal",
  );
  assert.equal(await app.terminal.getTitle(), before);
  await app.close();
});

test("a provider error shows pi's message", async () => {
  const app = await launch({ scenario: "failure" });
  await app.terminal.submit("go");
  await app.terminal.waitText("prompt is too long");
  const screen = await app.capture("provider-error");
  assert.match(screen, re`${glyphs.error} 400 invalid_request_error: prompt is too long`, screen);
  await app.close();
});

test("an expired login says so and names the command that signs in, with pi's words behind ctrl+o", async () => {
  const app = await launch({ scenario: "expired-login" });
  await app.terminal.submit("go");
  await app.terminal.waitText("login has expired");
  const collapsed = await app.capture("expired-login");
  assert.match(
    collapsed,
    re`${glyphs.error} the anthropic login has expired \u00b7 /login anthropic signs in again \u00b7 ctrl\+o`,
    collapsed,
  );
  assert.doesNotMatch(
    collapsed,
    /OAuth refresh|invalid_grant|postJson/,
    `the raw error shows:\n${collapsed}`,
  );
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("invalid_grant");
  const expanded = await app.capture("expired-login-expanded");
  assert.match(expanded, /OAuth refresh failed for anthropic/, expanded);
  await app.close();
});

test("an MCP server that fails to connect shows the cause and the command that deals with it", async () => {
  const app = await launch({ scenario: "mcp-failure" });
  await app.terminal.submit("go");
  await app.terminal.waitText("Carrying on without them.");
  const screen = await app.capture("mcp-failure");
  assert.match(
    screen,
    /MCP server linear needs a login \u00b7 \/mcp-auth linear signs in \u00b7 ctrl\+o/,
    screen,
  );
  assert.match(
    screen,
    /MCP server local-db did not connect: connection refused \u00b7 \/mcp reconnect local-db tries again/,
    screen,
  );
  assert.doesNotMatch(screen, /Streamable HTTP|ECONNREFUSED|probe:/, `the raw error shows:\n${screen}`);
  await app.close();
});

test("a retry that recovers leaves no failed attempt behind", async () => {
  const app = await launch({ scenario: "retry", delayMs: 20 });
  await app.terminal.submit("go");
  await app.terminal.waitText("Recovered after a retry.");
  // The retry line clears once pi reports the retry over, just after the reply.
  await app.terminal.waitText("retrying", { not: true });
  const screen = await app.capture("retried");
  assert.doesNotMatch(screen, /529/, `the failed attempt stayed:\n${screen}`);
  await app.close();
});

test("a prompt pi turns away comes back to the editor with the reason", async () => {
  const app = await launch({ scenario: "refusing" });
  await app.terminal.submit("an important prompt");
  await app.terminal.waitText("no login or API key for anthropic");
  await app.terminal.waitText("» an important prompt");
  await app.close();
});

test("after pi dies, escape is harmless and a draft is kept", async () => {
  const app = await launch({ scenario: "crash" });
  await app.terminal.submit("go");
  await app.terminal.waitText("pi stopped");
  await normalMode(app.terminal);
  await app.terminal.keyboard.press("Escape");
  await app.terminal.write("i");
  await app.terminal.submit("keep me");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const screen = await app.capture("after-crash");
  assert.doesNotMatch(screen, /Console|write failed/, `an error overlay opened:\n${screen}`);
  assert.match(screen, /» keep me/, screen);
  assert.doesNotMatch(screen, /steer/, `still in steering mode:\n${screen}`);
  await app.close();
});

test("a short screen keeps the editor and footer when suggestions open", async () => {
  const app = await launch({ scenario: "hello", cols: 60, rows: 14 });
  await app.terminal.type("/");
  await app.terminal.waitText("tab completes");
  const screen = await app.capture("squeezed");
  assert.match(screen, /» \//, `editor pushed off:\n${screen}`);
  assert.match(screen, /fake-model-1/, `footer pushed off:\n${screen}`);
  await app.close();
});

test("--resume opens the session picker", async () => {
  const app = await launch({ scenario: "resumed", argv: ["--resume"] });
  await app.terminal.waitText("resume");
  await app.close();
});

test("words on the command line become the first prompt", async () => {
  const app = await launch({ scenario: "hello", argv: ["fix", "the", "limits"] });
  await app.terminal.waitText("You said: fix the limits");
  await app.close();
});
