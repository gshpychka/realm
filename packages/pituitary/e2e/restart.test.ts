import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { launch, press, survivors, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ALT_UP = "\x1b[1;3A";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_P = "\x10";
const CTRL_S = "\x13";
const ESC = "\x1b";
/** The provider every model here comes from, as the model lists name it. */
const LOCAL = `${glyphs.model} local`;

after(async () => {
  await closeAll();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pi processes and embedded editors running under `home`; pi titles its process `pi`. */
function agents(home: string): { pi: string[]; nvim: string[] } {
  const running = survivors(home);
  return {
    pi: running.filter((line) => / pi$/.test(line)),
    nvim: running.filter((line) => line.includes("nvim") && line.includes("--embed")),
  };
}

async function settled(home: string, pid: string | undefined): Promise<{ pi: string[]; nvim: string[] }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const now = agents(home);
    const fresh = now.pi.length === 1 && !now.pi[0]?.startsWith(`${pid} `);
    if ((fresh && now.nvim.length === 1) || Date.now() > deadline) return now;
    await pause(50);
  }
}

/** Waits until nothing under `home` runs any more. */
async function gone(home: string): Promise<string[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const left = survivors(home);
    if (left.length === 0 || Date.now() > deadline) return left;
    await pause(50);
  }
}

/** A provider with three models pi counts as available; nothing here reaches its address. */
function localModels(home: string): void {
  const models = {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "local",
        models: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
      },
    },
  };
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify(models));
}

/** Writes `key` until `text` leaves the screen; a popup takes keys only a moment after it draws. */
async function dismiss(terminal: TuiTest, key: string, text: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    await terminal.write(key);
    await pause(250);
    if (!(await terminal.text()).includes(text)) return;
    if (Date.now() > deadline) throw new Error(`"${text}" stayed after writing ${JSON.stringify(key)}`);
  }
}

async function absent(terminal: TuiTest, text: string): Promise<void> {
  await pause(600);
  const screen = await terminal.text();
  assert.ok(!screen.includes(text), screen);
}

test("/trust saves the decision and restarts pi on the session, which then loads the project's files", async () => {
  let file = "";
  const app = await launch({
    pi: ["--no-extensions"],
    argv: ["--continue"],
    prepare: (_home, sessions, cwd) => {
      mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "prompts", "greet.md"),
        "---\ndescription: greet the project\n---\nhi\n",
      );
      const session = SessionManager.create(cwd, sessions);
      session.appendMessage({ role: "user", content: "shape the limits", timestamp: Date.now() });
      session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "both bounds hold" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      file = session.getSessionFile() ?? "";
    },
  });
  await app.terminal.waitText("both bounds hold");
  await app.terminal.type("/gre");
  await absent(app.terminal, "greet the project");
  await app.terminal.write(CTRL_C);
  const before = agents(app.home).pi[0]?.split(" ")[0];

  await app.terminal.submit("/trust");
  await app.terminal.waitText("this session untrusted · saved none");
  const picker = await app.capture("trust-picker");
  assert.match(picker, /▸ trust ~\/projects\/work\/sample/, picker);
  assert.match(picker, /trust the parent folder ~\/projects\/work +│/, picker);
  assert.match(picker, /do not trust ~\/projects\/work\/sample/, picker);
  await press(app.terminal, DOWN, "▸ trust the parent folder");
  await press(app.terminal, UP, "▸ trust ~/projects/work/sample");
  await app.terminal.submit();
  await app.terminal.waitText("saved trust decision: trusted; pi restarted to take it up");
  // The restarted UI draws the history afresh, its replies' markdown a moment after the rest.
  await app.terminal.waitText("both bounds hold");
  await app.capture("trust-restarted");
  assert.deepEqual(JSON.parse(readFileSync(join(app.home, ".pi", "agent", "trust.json"), "utf8")), {
    [app.cwd]: true,
  });
  const running = await settled(app.home, before);
  assert.equal(running.pi.length, 1, running.pi.join("\n"));
  assert.ok(!running.pi[0]?.startsWith(`${before} `), "the agent running is the one started afresh");
  assert.equal(running.nvim.length, 1, running.nvim.join("\n"));
  await app.terminal.submit("/session");
  await app.terminal.waitText(`file ~/${relative(app.home, file)}`);

  await app.terminal.type("/gre");
  await app.terminal.waitText("greet the project");
  await app.terminal.write(CTRL_C);
  await app.terminal.submit("/trust");
  await app.terminal.waitText("this session trusted · saved trusted");
  await app.capture("trust-saved");
  await dismiss(app.terminal, ESC, "this session trusted");
  await app.terminal.write(CTRL_D);
  assert.deepEqual(await gone(app.home), []);
  await app.close();
});

test("/scoped-models saves the models ctrl+p cycles and restarts pi to cycle them", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions"], prepare: localModels });
  const before = agents(app.home).pi[0]?.split(" ")[0];
  await app.terminal.submit("/scoped-models");
  await app.terminal.waitText("all checked");
  const all = await app.capture("scoped-models");
  assert.match(all, re`▸ ✓ alpha ${LOCAL}`, all);
  await press(app.terminal, DOWN, "▸ ✓ beta");
  await press(app.terminal, DOWN, "▸ ✓ gamma");
  await app.terminal.submit();
  await app.terminal.waitText("2 of 3 checked · unsaved");
  const unsaved = await app.capture("scoped-models-unsaved");
  assert.match(unsaved, re`▸ · gamma ${LOCAL}`, unsaved);
  await press(app.terminal, UP, "▸ ✓ beta");
  await app.terminal.write(ALT_UP);
  const reordered = await waitMatch(app.terminal, re`▸ ✓ beta ${LOCAL}.*\n.*✓ alpha ${LOCAL}`);
  assert.match(reordered, re`· gamma ${LOCAL}`, reordered);
  await press(app.terminal, CTRL_S, "saved 2 models for ctrl+p to cycle");
  await app.terminal.waitText("saved 2 models for ctrl+p to cycle; pi restarted to take it up");
  await app.capture("scoped-models-saved");
  const settings = JSON.parse(readFileSync(join(app.home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.enabledModels, ["local/beta", "local/alpha"]);
  const running = await settled(app.home, before);
  assert.equal(running.pi.length, 1, running.pi.join("\n"));
  assert.equal(running.nvim.length, 1, running.nvim.join("\n"));

  const seen = new Set<string>();
  for (let turn = 0; turn < 3; turn++) {
    await app.terminal.write(CTRL_P);
    await app.terminal.waitText("model: local/");
    const screen = await app.terminal.text();
    const model = /model: local\/(\w+)/.exec(screen)?.[1] ?? "";
    seen.add(model);
    await app.terminal.waitText(`model: local/${model}`, { not: true });
  }
  assert.deepEqual([...seen].sort(), ["alpha", "beta"]);
  await app.terminal.submit("/model");
  await app.terminal.waitText("model · enabled");
  const enabled = await app.terminal.text();
  assert.match(enabled, re`beta ${LOCAL}.*\n.*alpha ${LOCAL}.*\n.*2 of 2`, enabled);
  await dismiss(app.terminal, ESC, "model · enabled");

  await app.terminal.submit("/scoped-models");
  await app.terminal.waitText("2 of 3 checked");
  await dismiss(app.terminal, ESC, "2 of 3 checked");
  await app.terminal.write(CTRL_D);
  assert.deepEqual(await gone(app.home), []);
  await app.close();
});

test("a saved setting waits for the next start while the session cannot carry over", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("keep this");
  await app.terminal.waitText("You said: keep this");
  await app.terminal.submit("/trust");
  await app.terminal.waitText("do not trust");
  await press(app.terminal, DOWN, "▸ trust the parent folder");
  await app.terminal.submit();
  await app.terminal.waitText("saved trust decision: trusted; restart pituitary for this to take effect");
  await app.capture("trust-unsaved-session");
  await app.close();
});

test("a saved setting waits for the next start while pi works", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write it");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("/scoped-models");
  await app.terminal.waitText("all checked");
  await press(app.terminal, CTRL_S, "saved every model for ctrl+p to cycle");
  await app.terminal.waitText("saved every model for ctrl+p to cycle; restart pituitary");
  await app.close();
});
