import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { BRANCH, launch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const URL = "https://github.com/gshpychka/pituitary/pull/1234";

/** Ghostty's answer to the version query, which tells OpenTUI the terminal draws links. */
const GHOSTTY_VERSION = "\x1bP>|ghostty 1.2.3\x1b\\";

after(async () => {
  await closeAll();
});

/** The colour of the first cell on the footer rows holding `char`. */
async function colourOf(terminal: TuiTest, char: string): Promise<unknown> {
  const cells = await terminal.cells(0, 26, 100, 2);
  return cells.find((cell) => cell.char === char)?.fg;
}

/** The calls the fake gh logged, once at least `count` have arrived. */
async function calls(home: string, count: number): Promise<string[]> {
  const log = join(home, "gh.log");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) throw new Error(`gh was called ${lines.length} times, not ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const footerOf = (screen: string) => screen.split("\n").slice(-2).join("\n");

for (const [state, glyph, colour] of [
  ["open", glyphs.pullOpen, "#b8bb26"],
  ["draft", glyphs.pullDraft, "#a89984"],
  ["merged", glyphs.pullMerged, "#d3869b"],
  ["closed", glyphs.pullClosed, "#fb4934"],
] as const) {
  test(`a ${state} pull request shows its number beside the branch, coloured by its state`, async () => {
    const app = await launch({ scenario: "hello", env: { FAKE_GH_STATE: state } });
    await app.terminal.waitText("#1234");
    const footer = footerOf(await app.capture(`footer-pull-${state}`));
    assert.ok(
      footer.includes(`${glyphs.branch} ${BRANCH} ${glyph} #1234`),
      `pull request missing:\n${footer}`,
    );
    assert.equal(await colourOf(app.terminal, "#"), colour);
    assert.equal(await colourOf(app.terminal, glyph), colour);
    await app.close();
  });
}

test("a branch without a pull request shows none", async () => {
  const app = await launch({ scenario: "hello" });
  assert.deepEqual(await calls(app.home, 1), ["pr view --json number,url,state,isDraft"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const footer = footerOf(await app.capture("footer-pull-none"));
  assert.ok(footer.includes(`${glyphs.branch} ${BRANCH}`), footer);
  assert.doesNotMatch(footer, /#\d/, footer);
  await app.close();
});

test("a directory outside any repository asks gh nothing", async () => {
  const app = await launch({ scenario: "hello", branch: false, env: { FAKE_GH_STATE: "open" } });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const footer = footerOf(await app.capture("footer-pull-no-git"));
  assert.doesNotMatch(footer, /#\d/, footer);
  assert.equal(existsSync(join(app.home, "gh.log")), false);
  await app.close();
});

test("PITUITARY_GH set empty turns the lookup off", async () => {
  const app = await launch({ scenario: "hello", env: { PITUITARY_GH: "", FAKE_GH_STATE: "open" } });
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const footer = footerOf(await app.capture("footer-pull-gh-off"));
  assert.ok(footer.includes(`${glyphs.branch} ${BRANCH}`), footer);
  assert.doesNotMatch(footer, /#\d/, footer);
  assert.equal(existsSync(join(app.home, "gh.log")), false);
  // The test's HOME holds no gh login, so any lookup that runs logs a line.
  const log = existsSync(join(app.home, "tui.log")) ? readFileSync(join(app.home, "tui.log"), "utf8") : "";
  assert.doesNotMatch(log, /pull request lookup/, log);
  await app.close();
});

test("gh failing leaves the pull request out, with one line in the log", async () => {
  const app = await launch({ scenario: "hello", env: { FAKE_GH_STATE: "failing" } });
  await calls(app.home, 1);
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  await calls(app.home, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const footer = footerOf(await app.capture("footer-pull-failing"));
  assert.doesNotMatch(footer, /#\d/, footer);
  const log = readFileSync(join(app.home, "tui.log"), "utf8");
  assert.equal(
    log.split("pull request lookup failed: error connecting to api.github.com").length - 1,
    1,
    log,
  );
  await app.close();
});

test("a settled run looks the pull request up again, since the agent may have opened it", async () => {
  const app = await launch({ scenario: "hello" });
  await calls(app.home, 1);
  await app.terminal.submit("hi");
  await app.terminal.waitText("You said: hi");
  assert.equal((await calls(app.home, 2)).length, 2);
  await app.close();
});

test("in a terminal that draws links, the number is a link to the pull request", async () => {
  const app = await launch({
    scenario: "hello",
    record: true,
    // gh answers after the terminal has said it draws links, so the number is drawn as one.
    // COLORTERM claims nothing, so the terminal's version alone says it draws links.
    env: { FAKE_GH_STATE: "open", FAKE_GH_DELAY: "0.8", COLORTERM: "" },
  });
  await app.terminal.write(GHOSTTY_VERSION);
  await app.terminal.waitText("#1234");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await app.terminal.write("\x04");
  await app.terminal.waitExit({ timeout: 10_000 });
  const raw = app.raw();
  const ST = re`(?:\x1b\\|\x07)`;
  const link = re.s`\x1b\]8;[^;\x1b\x07]*;${URL}${ST}((?:(?!\x1b\]8;).)*?)\x1b\]8;;${ST}`;
  const found = link.exec(raw);
  assert.ok(found, "no OSC 8 link to the pull request in the terminal output");
  // Between the open and the close sit only styling and cursor moves, and the number.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are what this removes
  assert.equal((found[1] ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), "#1234");
  await app.close();
});

test("in a terminal that says nothing of links, the number is drawn as plain text", async () => {
  // OpenTUI takes a terminal with 24-bit colour to draw links too, so this one claims neither.
  const app = await launch({
    scenario: "hello",
    record: true,
    env: { FAKE_GH_STATE: "open", COLORTERM: "" },
  });
  await app.terminal.waitText("#1234");
  await app.terminal.write("\x04");
  await app.terminal.waitExit({ timeout: 10_000 });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an OSC 8 opener is what this looks for
  assert.doesNotMatch(app.raw(), /\x1b\]8;/);
  await app.close();
});

test("a narrow footer drops the pull request before the branch", async () => {
  const app = await launch({ scenario: "hello", env: { FAKE_GH_STATE: "open" } });
  await app.terminal.waitText("#1234");
  // Twenty columns hold the branch beside what is left of the directory, and no more.
  await app.terminal.resize(20, 28);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const footer = footerOf(await app.capture("footer-pull-narrow"));
  assert.ok(footer.includes(`${glyphs.branch} ${BRANCH}`), footer);
  assert.doesNotMatch(footer, /#1234/, footer);
  await app.close();
});
