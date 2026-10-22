import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, PROJECT, press } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const CTRL_L = "\x0c";
const CTRL_P = "\x10";
const FAINT = "#7c6f64";
const ALT_N = "\x1bn";

after(async () => {
  await closeAll();
});

test("/model opens a picker and the choice lands in the footer", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("/mo");
  await app.terminal.waitText("/model [provider/id]");
  await app.capture("slash-completion");
  await app.terminal.submit();
  await app.terminal.waitText("2 of 2");
  await app.capture("picker-model");
  await press(app.terminal, DOWN, "▸ fake-model-2");
  await app.terminal.submit();
  await app.terminal.waitText(`fake-model-2 ${glyphs.thinking} medium`);
  await app.close();
});

test("the picker narrows as the operator types", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.write(CTRL_L);
  await app.terminal.waitText("2 of 2");
  await app.terminal.type("model-2");
  await app.terminal.waitText("1 of 2");
  await app.terminal.keyboard.press("Escape");
  await app.terminal.waitText("1 of 2", { not: true });
  await app.close();
});

test("shift+tab cycles thinking and ctrl+p cycles the model", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.write(SHIFT_TAB);
  await app.terminal.waitText(`fake-model-1 ${glyphs.thinking} high`);
  await app.terminal.write(CTRL_P);
  await app.terminal.waitText(`fake-model-2 ${glyphs.thinking} high`);
  await app.close();
});

test("/resume lists earlier sessions in this directory and opens the chosen one", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (_home, sessions, cwd) => {
      const earlier = SessionManager.create(cwd, sessions);
      earlier.appendMessage({
        role: "user",
        content: "earlier question about limits",
        timestamp: Date.now(),
      });
      earlier.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "the earlier answer" }],
        api: "anthropic-messages",
        provider: "fake",
        model: "fake-model-1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    },
  });
  await app.terminal.submit("/resume");
  await app.terminal.waitText("earlier question about limits");
  await app.capture("picker-resume");
  await app.terminal.submit();
  await app.terminal.waitText("the earlier answer");
  const screen = await app.capture("resumed-picked");
  assert.match(screen, /▌ earlier question about limits/, screen);
  await app.close();
});

test("/new starts an empty session", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/new");
  await app.terminal.waitText("Ask pi something to get started");
  await app.close();
});

test("/fork starts from an earlier prompt and puts it back in the editor", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("second");
  await app.terminal.waitText("You said: second");
  await app.terminal.submit("/fork");
  await app.terminal.waitText("fork from");
  await press(app.terminal, DOWN, "▸ first");
  await app.terminal.submit();
  await app.terminal.waitText("» first");
  const screen = await app.terminal.text();
  assert.doesNotMatch(screen, /You said: second/, `the forked session kept later messages:\n${screen}`);
  await app.close();
});

test("/compact replaces the history with its summary", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.submit("/compact keep the plan");
  await app.terminal.waitText(`${glyphs.info} compacted from ${glyphs.tokens} 42,000 tokens`);
  const screen = await app.capture("compacted");
  assert.match(
    screen,
    re`${glyphs.summary} \[compaction\] compacted from ${glyphs.tokens} 42,000 tokens`,
    screen,
  );
  assert.doesNotMatch(screen, /You said: first/, screen);
  await app.close();
});

test("/name names the session in the footer", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("/name payout limits");
  await app.terminal.waitText(`${glyphs.session} payout limits`);
  await app.close();
});

test("a stock command says why when the agent lacks pituitary's bridge", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("/reload");
  await app.terminal.waitText("needs pituitary's bridge extension");
  await app.close();
});

test("a command pi owns goes to pi", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("/pla");
  await app.terminal.waitText("Enter plan mode");
  await app.terminal.submit();
  await app.terminal.waitText("You said: /plan");
  await app.close();
});

test("an open completion list leaves modified shortcuts to the app", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("/mo");
  await app.terminal.waitText("/model [provider/id]");
  await app.terminal.write(SHIFT_TAB);
  await app.terminal.waitText(`fake-model-1 ${glyphs.thinking} high`);
  const screen = await app.capture("completion-modified-shortcut");
  assert.match(screen, /» \/mo/, screen);
  await app.close();
});

test("@ completes a file path from the working tree", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("look at @srcmain");
  await app.terminal.waitText("@src/main.ts");
  await app.terminal.write(TAB);
  await app.terminal.waitText("» look at @src/main.ts");
  await app.close();
});

test("quoted file mentions complete paths with spaces", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (_home, _sessions, cwd) => writeFileSync(join(cwd, "docs", "user guide.md"), "guide"),
  });
  await app.terminal.type('look @"docs/user ');
  await app.terminal.waitText('@"docs/user guide.md"');
  await app.terminal.write(TAB);
  await app.terminal.waitText('» look @"docs/user guide.md"');
  const screen = await app.capture("mention-quoted-path");
  assert.match(screen, /» look @"docs\/user guide.md"/, screen);
  await app.close();
});

test("a new mention finds files created since the previous completion", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type("@srcmain");
  await app.terminal.waitText("@src/main.ts");
  await app.terminal.write("\x03");
  await app.terminal.waitText("ask pi");
  writeFileSync(join(app.home, PROJECT, "newly-created.txt"), "new file");
  await app.terminal.type("@newly");
  await app.terminal.waitText("@newly-created.txt");
  await app.terminal.write(TAB);
  await app.terminal.waitText("» @newly-created.txt");
  const screen = await app.capture("mention-new-file");
  assert.match(screen, /» @newly-created.txt/, screen);
  await app.close();
});

test("the operator's keybindings.json binds session keys", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (home) => {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".pi", "agent", "keybindings.json"),
        JSON.stringify({ "app.session.new": "alt+n" }),
      );
    },
  });
  await app.terminal.submit("first");
  await app.terminal.waitText("You said: first");
  await app.terminal.write(ALT_N);
  await app.terminal.waitText("Ask pi something to get started");
  await app.close();
});

test("/model draws each provider's mark in its brand colour, the rest in the detail's", async () => {
  const app = await launch({ scenario: "providers" });
  await app.terminal.submit("/model");
  await app.terminal.waitText("5 of 5");
  await app.capture("picker-model-providers");
  const cells = await app.terminal.cells(0, 0, 100, 28);
  const colours = (char: string) => [
    ...new Set(cells.filter((cell) => cell.char === char).map((cell) => cell.fg)),
  ];
  assert.deepEqual(colours(glyphs.anthropic), ["#d97757"]);
  assert.deepEqual(colours(glyphs.openai), ["#10a37f"]);
  assert.deepEqual(colours(glyphs.google), ["#4285f4"]);
  assert.deepEqual(colours(glyphs.copilot), [FAINT]);
  assert.deepEqual(colours(glyphs.model), [FAINT]);
  await app.close();
});

test("/model names the models it knows, keeps each id in the detail, and narrows by either", async () => {
  const app = await launch({ scenario: "providers" });
  await app.terminal.submit("/model");
  await app.terminal.waitText("5 of 5");
  const screen = await app.terminal.text();
  assert.match(screen, re`Sonnet 4\.5 ${glyphs.anthropic} anthropic/claude-sonnet-4-5`, screen);
  assert.match(screen, re`GPT-5\.1 Codex ${glyphs.openai} openai-codex/gpt-5\.1-codex`, screen);
  assert.match(screen, re`qwen3 ${glyphs.model} ollama`, screen);
  await app.terminal.type("gpt-5.1-codex");
  await app.terminal.waitText("1 of 5");
  await app.terminal.submit();
  await app.terminal.waitText("model: GPT-5.1 Codex · openai-codex/gpt-5.1-codex");
  await app.terminal.waitText(`${glyphs.openai} GPT-5.1 Codex`);
  await app.capture("model-named");
  await app.close();
});

test("/scoped-models draws each provider's mark in its brand colour", async () => {
  const app = await launch({ scenario: "providers" });
  await app.terminal.submit("/scoped-models");
  await app.terminal.waitText("all checked");
  await app.capture("scoped-models-providers");
  const screen = await app.terminal.text();
  assert.ok(screen.includes("GPT-5.1 Codex") && screen.includes("openai-codex/gpt-5.1-codex"), screen);
  const cells = await app.terminal.cells(0, 0, 100, 28);
  const colours = (char: string) => [
    ...new Set(cells.filter((cell) => cell.char === char).map((cell) => cell.fg)),
  ];
  assert.deepEqual(colours(glyphs.openai), ["#10a37f"]);
  assert.deepEqual(colours(glyphs.google), ["#4285f4"]);
  assert.deepEqual(colours(glyphs.copilot), [FAINT]);
  await app.close();
});
