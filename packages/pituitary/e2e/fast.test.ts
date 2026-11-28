import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const BOLT = "\u{f140b}";

test("/fast marks the ChatGPT model in the footer and asks the provider for priority", async () => {
  const app = await launchPi();
  try {
    app.provider.reply("Answered at priority.");
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
      app.provider.requests.map((request) => request.body.service_tier),
      ["priority"],
    );
    await app.terminal.submit("/fast");
    await waitMatch(app.terminal, new RegExp(`gpt-6\\.1-sol(?! ${BOLT})`));
    await app.capture("fast-off");
  } finally {
    await app.close();
    await app.provider.close();
  }
});
