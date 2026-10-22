import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { stored } from "../packages/rpc/src/scripted.ts";
import { boot, click, launch, pastGrace, press, REPO, wheel } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});
const fixture = join(REPO, "packages/tui/src/components/choices.fixture.tsx");

test("a narrow picker filters to the first result and accepts a mouse choice", async () => {
  const app = await boot({ entry: fixture, ready: "choose a model", cols: 36, rows: 14 });
  try {
    await app.terminal.type("match");
    await app.terminal.waitText("▸ match first");
    const screen = await app.capture("polish-picker-filtered");
    assert.match(screen, /draft stays here[\s\S]*footer stays here/, screen);
    const row = screen.split("\n").findIndex((line) => line.includes("match second"));
    await click(app.terminal, 8, row);
    await app.terminal.waitText("second");
    await app.terminal.waitText("choose a model", { not: true });
    assert.doesNotMatch(await app.terminal.text(), /choose a model/);
  } finally {
    await app.close();
  }
});

test("an alternate picker reports loading and a recoverable error", async () => {
  const app = await boot({ entry: fixture, ready: "choose a model", cols: 60, rows: 14 });
  try {
    await press(app.terminal, "\t", "loading…");
    const loading = await app.capture("polish-picker-loading");
    assert.doesNotMatch(loading, /other current/, loading);
    await app.terminal.submit();
    await app.terminal.waitText("could not load: sessions unavailable");
    await app.capture("polish-picker-error");
    await press(app.terminal, "\t", "▸ match first");
    await app.capture("polish-picker-recovered");
  } finally {
    await app.close();
  }
});

test("a narrow checklist keeps the toggled row selected as its order changes", async () => {
  const app = await boot({
    entry: fixture,
    ready: "choose models",
    env: { CHOICES_VIEW: "checklist" },
    cols: 36,
    rows: 14,
  });
  try {
    await press(app.terminal, "\x1b[B", "▸ ✓ match second");
    await app.terminal.submit();
    await app.terminal.waitText("▸ · match second");
    const screen = await app.capture("polish-checklist-unchecked");
    assert.match(screen, /2 of 3 checked/, screen);
    assert.match(screen, /draft stays here[\s\S]*footer stays here/, screen);
    await app.terminal.submit();
    await app.terminal.waitText("all checked");
  } finally {
    await app.close();
  }
});

test("the todo panel shows current work ahead of a long completed prefix", async () => {
  const app = await boot({
    entry: fixture,
    ready: "active task",
    env: { CHOICES_VIEW: "todo" },
    cols: 60,
    rows: 18,
  });
  try {
    const screen = await app.capture("polish-todo-current");
    assert.match(screen, /todo 8\/10/, screen);
    assert.match(screen, /active task[\s\S]*next task/, screen);
    assert.doesNotMatch(screen, /removed task/, screen);
  } finally {
    await app.close();
  }
});

test("a long queue on a short terminal leaves the draft and footer reachable", async () => {
  const app = await launch({ scenario: "long", delayMs: 1500, cols: 60, rows: 14 });
  try {
    await app.terminal.submit("start");
    await app.terminal.waitText("line 1 of the long answer");
    for (let index = 0; index < 12; index++) {
      await app.terminal.submit(`queued ${index}`);
      if (index < 2) await app.terminal.waitText(`steering queued ${index}`);
      else await app.terminal.waitText(`${index} queued messages`);
    }
    await app.terminal.type("keep drafting");
    await app.terminal.waitText("keep drafting");
    const screen = await app.capture("polish-short-queue");
    assert.match(screen, /keep drafting/, screen);
    assert.match(screen, /fake-model-1/, screen);
  } finally {
    await app.close();
  }
});

test("extension widgets share spare rows with a popup and return after resizing", async () => {
  const app = await launch({ scenario: "display" });
  try {
    await app.terminal.submit("show widgets");
    await app.terminal.waitText("Display set.");
    await app.terminal.waitText("» implement the plan");
    await app.terminal.write("\x15");
    await app.terminal.submit("/model");
    await app.terminal.waitText("2 of 2");
    await app.terminal.waitIdle();
    const wide = await app.capture("polish-popup-widget");
    assert.match(wide, /plan: 1\. read limits\.ts/, wide);
    assert.match(wide, /filter/, wide);
    assert.match(wide, /fake-model-1/, wide);
    await app.terminal.resize(40, 10);
    await app.terminal.waitText("enter pick · esc close · 2 of 2");
    await app.terminal.waitText("plan: 1. read limits.ts", { not: true });
    await app.terminal.waitIdle();
    const narrow = await app.capture("polish-popup-widget-40x10");
    assert.match(narrow, /enter pick/, narrow);
    assert.match(narrow, /fake-model-1/, narrow);
    await app.terminal.resize(100, 28);
    await app.terminal.waitText("plan: 1. read limits.ts");
    await app.terminal.waitText("2 of 2 · ↑↓ move");
    await app.terminal.waitIdle();
    await app.capture("polish-popup-widget-restored");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("filter", { not: true });
    await app.terminal.resize(60, 14);
    await app.terminal.submit("/scoped-models");
    await app.terminal.waitText("ctrl+s save");
    await app.terminal.waitIdle();
    const tight = await app.capture("polish-popup-widget-tight");
    assert.equal(tight.split("\n")[0]?.trim(), "… 2 more widget lines", tight);
  } finally {
    await app.close();
  }
});

for (const size of [
  { cols: 80, rows: 12 },
  { cols: 40, rows: 10 },
]) {
  test(`pickers and checklists retain their controls and footer at ${size.cols}×${size.rows}`, async () => {
    const app = await launch({ scenario: "hello", ...size });
    try {
      await app.terminal.submit("/model");
      await app.terminal.waitText("enter pick");
      await app.terminal.waitIdle();
      const picker = await app.capture(`polish-picker-${size.cols}x${size.rows}`);
      assert.match(picker, /filter/, picker);
      assert.match(picker, /esc close/, picker);
      assert.match(picker, /fake-model-1/, picker);
      if (size.rows === 10) assert.equal(picker.split("\n")[0]?.trim(), "model", picker);
      await app.terminal.keyboard.press("Escape");
      await app.terminal.waitText("filter", { not: true });
      await app.terminal.submit("/scoped-models");
      await app.terminal.waitText("ctrl+s save");
      await app.terminal.waitIdle();
      const checklist = await app.capture(`polish-checklist-${size.cols}x${size.rows}`);
      assert.match(checklist, /scoped models/, checklist);
      assert.match(checklist, /enter check/, checklist);
      assert.match(checklist, /fake-model-1/, checklist);
    } finally {
      await app.close();
    }
  });
}

test("confirm, input, and multi-line extension dialogs fit a 40×10 terminal", async () => {
  const app = await launch({ scenario: "dialogs", cols: 40, rows: 10 });
  try {
    await app.terminal.submit("start");
    await app.terminal.waitText("Replace notes.md?");
    await pastGrace();
    assert.match(await app.capture("polish-dialog-confirm-40x10"), /fake-model-1/);
    await app.terminal.type("y");
    await app.terminal.waitText("Name the branch");
    await pastGrace();
    assert.match(await app.capture("polish-dialog-input-40x10"), /fake-model-1/);
    await app.terminal.submit("feat/polish");
    await app.terminal.waitText("Describe the change");
    await pastGrace();
    await app.terminal.type("polish");
    await app.terminal.waitText("polish");
    const editor = await app.capture("polish-dialog-editor-40x10");
    assert.match(editor, /ctrl\+s save/, editor);
    assert.match(editor, /fake-model-1/, editor);
    await app.terminal.write("\x13");
    await app.terminal.waitText("confirm=yes");
  } finally {
    await app.close();
  }
});

test("a long confirmation scrolls with the keyboard and ignores modified answer keys", async () => {
  const app = await boot({
    entry: fixture,
    ready: "Review line 1",
    env: { CHOICES_VIEW: "dialog" },
    cols: 40,
    rows: 12,
  });
  try {
    await pastGrace();
    await app.terminal.write("\x1by");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.terminal.text(), /answered/);
    await app.terminal.write("\x1b[6~".repeat(4));
    await app.terminal.waitText("Review line 12");
    const screen = await app.capture("polish-dialog-long-message");
    assert.match(screen, /footer stays here/, screen);
    await app.terminal.type("y");
    await app.terminal.waitText("answered");
  } finally {
    await app.close();
  }
});

test("the welcome screen names configured shortcuts and omits disabled ones", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (home) => {
      const config = join(home, ".pi", "agent");
      mkdirSync(config, { recursive: true });
      writeFileSync(
        join(config, "keybindings.json"),
        JSON.stringify({ "app.model.select": "alt+m", "app.thinking.toggle": [] }),
      );
    },
  });
  try {
    const screen = await app.capture("polish-welcome-bindings");
    assert.match(screen, /alt\+m +pick a model/, screen);
    assert.doesNotMatch(screen, /ctrl\+l|ctrl\+t/, screen);
  } finally {
    await app.close();
  }
});

test("a long dialog title scrolls without hiding its answer controls", async () => {
  const app = await boot({
    entry: fixture,
    ready: "Question part 1",
    env: { CHOICES_VIEW: "dialog-title" },
    cols: 40,
    rows: 14,
  });
  try {
    const initial = await app.terminal.text();
    const titleRow = initial.split("\n").findIndex((line) => line.includes("Question part 1"));
    await wheel(app.terminal, 8, titleRow, 8);
    await app.terminal.waitText("Question part 6");
    const screen = await app.capture("polish-dialog-long-title");
    assert.match(screen, /esc cancel/, screen);
    assert.match(screen, /footer stays here/, screen);
  } finally {
    await app.close();
  }
});

test("long Unicode choice labels stay on one line beside the filter and controls", async () => {
  const app = await boot({
    entry: fixture,
    ready: "choose a model",
    env: { CHOICES_VIEW: "long" },
    cols: 40,
    rows: 12,
  });
  try {
    const screen = await app.capture("polish-picker-long-labels");
    assert.match(screen, /▸ other current/, screen);
    assert.match(screen, /enter pick/, screen);
    assert.match(screen, /footer stays here/, screen);
    assert.equal(
      screen.split("\n").filter((line) => /match (first|second)|other current/.test(line)).length,
      3,
      screen,
    );
  } finally {
    await app.close();
  }
});

test("paging into an older history batch keeps the adjacent prompts in view", async () => {
  const app = await launch({
    scenario: "hello",
    prepare: (_home, sessions, cwd) => {
      const earlier = SessionManager.create(cwd, sessions);
      for (let index = 1; index <= 200; index++)
        earlier.appendMessage({ role: "user", content: `history prompt ${index}`, timestamp: Date.now() });
      const reply = stored.assistant({ text: "history answer" });
      if (reply.role !== "assistant") throw new Error("expected a stored assistant reply");
      earlier.appendMessage(reply);
    },
  });
  try {
    await app.terminal.submit("/resume");
    await app.terminal.waitText("history prompt 1");
    await app.terminal.submit();
    await app.terminal.waitText("history prompt 200");
    for (let step = 0; step < 50; step++) {
      if ((await app.terminal.text()).includes("51 earlier entries")) break;
      await app.terminal.write("\x1b[5~");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await app.terminal.waitText("51 earlier entries");
    await app.terminal.write("\x1b[5~");
    await app.terminal.waitText("history prompt 51");
    const screen = await app.capture("polish-history-anchor");
    assert.match(screen, /history prompt 52\b/, screen);
    assert.doesNotMatch(screen, /history prompt 1\b/, screen);
  } finally {
    await app.close();
  }
});

test("inline thinking, output, and summary hints use the configured bindings", async () => {
  const prepare = (home: string) => {
    const config = join(home, ".pi", "agent");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "keybindings.json"),
      JSON.stringify({ "app.tools.expand": "alt+o", "app.thinking.toggle": "alt+t" }),
    );
  };
  const app = await launch({ scenario: "markdown", rows: 40, prepare });
  try {
    await app.terminal.submit("plan");
    await app.terminal.waitText("Keep the lower bound");
    await app.terminal.write("\x1bo");
    await app.terminal.waitText("needs an upper bound");
    await app.terminal.write("\x1bt");
    await app.terminal.waitText("thinking… · alt+t");
    const thinking = await app.capture("polish-custom-thinking-hint");
    assert.doesNotMatch(thinking, /ctrl\+o|ctrl\+t/, thinking);
    await app.terminal.write("\x1bo");
    await app.terminal.submit("/compact");
    await app.terminal.waitText("tokens · alt+o");
    await app.capture("polish-custom-summary-hint");
  } finally {
    await app.close();
  }
  const tools = await launch({ scenario: "tools", rows: 40, prepare });
  try {
    await tools.terminal.submit("run tools");
    await tools.terminal.waitText("Done.");
    const screen = await tools.terminal.text();
    const row = screen.split("\n").findIndex((line) => line.includes("6 tools"));
    await click(tools.terminal, 4, row);
    await tools.terminal.waitText("more lines · alt+o");
    const output = await tools.capture("polish-custom-output-hint");
    assert.doesNotMatch(output, /ctrl\+o|ctrl\+t/, output);
  } finally {
    await tools.close();
  }
});

test("inline action hints disappear when their bindings are disabled", async () => {
  const app = await launch({
    scenario: "markdown",
    rows: 40,
    prepare: (home) => {
      const config = join(home, ".pi", "agent");
      mkdirSync(config, { recursive: true });
      writeFileSync(
        join(config, "keybindings.json"),
        JSON.stringify({ "app.tools.expand": [], "app.thinking.toggle": [] }),
      );
    },
  });
  try {
    await app.terminal.submit("plan");
    await app.terminal.waitText("Keep the lower bound");
    const rows = (await app.terminal.text()).split("\n");
    await click(
      app.terminal,
      4,
      rows.findIndex((line) => line.includes("thought")),
    );
    await app.terminal.waitText("needs an upper bound");
    const screen = await app.capture("polish-unbound-thinking-hint");
    assert.doesNotMatch(screen, /ctrl\+o|ctrl\+t/, screen);
    await app.terminal.submit("/compact");
    await app.terminal.waitText("compacted from");
    const summary = await app.capture("polish-unbound-summary-hint");
    assert.doesNotMatch(summary, /tokens ·/, summary);
  } finally {
    await app.close();
  }
});
