import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { CURATOR_URL } from "../packages/fake-pi/scenarios/curator.ts";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { click, launch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const CTRL_O = "\x0f";
const CTRL_T = "\x14";
const PAGE_UP = "\x1b[5~";

after(async () => {
  await closeAll();
});

test("a reply renders as markdown with highlighted code", async () => {
  const app = await launch({ scenario: "markdown" });
  await app.terminal.submit("plan it");
  await app.terminal.waitText("Keep the lower bound");
  // Readable text draws immediately; syntax colours arrive with the parser's reply.
  await app.terminal.expectText("export", { fg: "#fb4934", timeout: 5000 });
  const screen = await app.capture("markdown");
  assert.doesNotMatch(screen, /## Plan|\*\*limits|```/, `markdown syntax shown raw:\n${screen}`);
  await app.close();
});

test("a run's tool calls fold into one line, open to a preview of each, and ctrl+o shows them whole", async () => {
  const app = await launch({ scenario: "tools", rows: 80 });
  await app.terminal.submit("fix it");
  await app.terminal.waitText("Done.");
  const folded = await app.capture("tools-folded");
  assert.match(folded, re`▸ ${glyphs.tool} 6 tools · 1 failed\s*\n\s*\n ● Done\.`, folded);
  assert.doesNotMatch(folded, /read src\/limits|Reading first/, `the work shows past its line:\n${folded}`);

  const row = folded.split("\n").findIndex((line) => line.includes("6 tools"));
  await click(app.terminal, 2, row);
  await app.terminal.waitText("╰");
  const collapsed = await app.capture("tools-collapsed");
  assert.match(collapsed, re`✓ ${glyphs.read} read src/limits\.ts:1-30 · 30 lines`, collapsed);
  assert.doesNotMatch(collapsed, /source line 1\b/, `a collapsed read shows the file:\n${collapsed}`);
  assert.match(
    collapsed,
    /- 5 const MAX = 24; *│\n\s*│\s+\+ 5 const MAX = 168;/,
    `diff missing:\n${collapsed}`,
  );
  assert.match(collapsed, /✗ \$ false/, collapsed);
  assert.doesNotMatch(collapsed, /source line 11/, collapsed);
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("source line 30");
  await app.capture("tools-expanded");
  await app.close();
});

test("ctrl+t folds thinking to a marker and back", async () => {
  const app = await launch({ scenario: "markdown" });
  await app.terminal.submit("plan it");
  await app.terminal.waitText("Keep the lower bound");
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("needs an upper bound");
  await app.terminal.write(CTRL_T);
  await app.terminal.waitText(`${glyphs.thinking} thinking… · ctrl+t`);
  await app.capture("thinking-folded");
  const screen = await app.terminal.text();
  assert.doesNotMatch(screen, /needs an upper bound/, screen);
  await app.terminal.write(CTRL_T);
  await app.terminal.waitText("needs an upper bound");
  await app.close();
});

test("the todo list shows in the call and in a panel above the editor while open, and only there", async () => {
  const app = await launch({ scenario: "todo" });
  await app.terminal.submit("go");
  await app.terminal.waitText("Working through the list.");
  const screen = await app.capture("todo");
  assert.match(screen, re`${glyphs.todo} todo 1/3`, screen);
  assert.match(screen, /▸ Adding the upper bound/, screen);
  assert.doesNotMatch(screen, /Todos \(1\/3\)/, `rpiv-todo's widget drew the list again:\n${screen}`);
  await app.close();
});

test("tools from the operator's packages render from their details", async () => {
  const app = await launch({ scenario: "packages", rows: 40 });
  await app.terminal.submit("go");
  await app.terminal.waitText("All four tools reported.");
  await app.terminal.write(CTRL_O);
  await app.terminal.waitText("scout: find the call sites");
  const screen = await app.capture("packages");
  assert.match(screen, /scout: find the call sites/, screen);
  assert.match(screen, re`7 tool calls · ${glyphs.tokens} 12\.4k tokens · 8\.3s`, screen);
  assert.match(screen, /Cap at\? → 168h/, screen);
  assert.ok(screen.includes(`review the results at ${CURATOR_URL}`), screen);
  assert.match(screen, re`✓ ${glyphs.plan} plan ready`, screen);
  await app.close();
});

test("a reply cut off at the output limit says so", async () => {
  const app = await launch({ scenario: "cutoff" });
  await app.terminal.submit("go");
  await app.terminal.waitText("reached the output limit");
  const screen = await app.capture("cutoff");
  assert.match(screen, re`${glyphs.warning} the reply reached the output limit`, screen);
  await app.close();
});

test("page up scrolls the conversation back", async () => {
  const app = await launch({ scenario: "long" });
  await app.terminal.submit("write a lot");
  await app.terminal.waitText("line 40 of the long answer");
  await app.terminal.write(PAGE_UP);
  await app.terminal.write(PAGE_UP);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const screen = await app.capture("scrolled");
  assert.doesNotMatch(screen, /line 40 of the long answer/, `did not scroll:\n${screen}`);
  await app.close();
});
