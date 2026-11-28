import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { boot, click, normalMode, REPO, settled, waitMatch } from "./helpers/harness.ts";
import { API_KEY, launchPi, type PiLaunch } from "./helpers/pi.ts";

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

/** Another extension's `usage` command, whose name Pi then gives to this one alone, renaming Pituitary's. */
const OTHER_USAGE = `
export default function (pi) {
  pi.registerCommand("usage", {
    description: "another extension's usage",
    handler: async (_args, ctx) => ctx.ui.notify("the other usage ran", "warning"),
  });
}
`;

for (const cols of [44, 120])
  test(`provider usage opens, observes API limits, and closes at ${cols} columns`, async () => {
    // The reply streams its words, then holds the run open until the test lets it finish.
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let app: PiLaunch | undefined;
    try {
      app = await launchPi({
        apiModels: [{ id: "usage-fixture" }],
        cols,
        rows: 36,
        extensions: { "other-usage.ts": OTHER_USAGE },
      });
      app.provider.reply({
        text: "Observed the API response.",
        until: finished,
        headers: {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "1m",
        },
      });
      await clickCard(app.terminal);
      await app.terminal.waitText("session estimate");
      assert.equal(app.provider.requests.length, 0);
      const unavailable = await app.capture(`usage-unavailable-${cols}`);
      assert.match(unavailable, /usage unavailable/);
      // Pi renamed Pituitary's usage command, and the card names it as Pi does, whole or not at all.
      for (const row of unavailable.split("\n").filter((line) => line.includes("/usage")))
        assert.match(row, /\/usage:\d+ refresh updates/);
      const named = /\/(usage:\d+) refresh updates/.exec(unavailable)?.[1];
      if (cols === 120) assert.ok(named, unavailable);
      await app.terminal.submit("inspect");
      await app.terminal.waitText("Observed the API response.");
      // While the run goes, the interrupt stops it rather than closing the card.
      await normalMode(app.terminal);
      await app.terminal.keyboard.press("Escape");
      await app.terminal.waitText("aborted");
      await settled(app.terminal);
      await app.terminal.waitIdle();
      const screen = await app.capture(`usage-api-${cols}`);
      assert.match(screen, /100/);
      assert.match(screen, /session estimate/);
      assert.doesNotMatch(screen, new RegExp(`${API_KEY}|\\{"report"`));
      assert.equal(app.provider.requests.length, 1);
      await app.terminal.write("i");
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
      if (named) {
        // The command as Pi named it closes the card, and neither runs the other extension's nor asks the model.
        await app.terminal.write("i");
        await app.terminal.write("\x1bu");
        await app.terminal.waitText("session estimate");
        await app.terminal.submit(`/${named} off`);
        await waitMatch(app.terminal, /^(?![\s\S]*session estimate)/);
        await app.terminal.waitIdle();
        assert.doesNotMatch(await app.terminal.text(), /the other usage ran/);
        assert.equal(app.provider.requests.length, 1);
      }
    } finally {
      finish();
      await app?.close();
    }
  });
