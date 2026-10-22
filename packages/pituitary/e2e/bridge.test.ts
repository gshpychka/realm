import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeAll } from "@microsoft/tui-test";
import { launch, pastGrace, press, REPO, survivors } from "./helpers/harness.ts";

const CUSTOM = join(REPO, "e2e/fixtures/custom.ts");
const PROBE = join(REPO, "e2e/fixtures/probe.ts");
const DOWN = "\x1b[B";
const CTRL_C = "\x03";
const CTRL_D = "\x04";

after(async () => {
  await closeAll();
});

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const reply = (text: string): Parameters<SessionManager["appendMessage"]>[0] => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-5",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
});

test("an extension's own component draws in pituitary and takes the keys", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", CUSTOM] });
  await app.terminal.submit("/flavour");
  await app.terminal.waitText("pistachio");
  const opened = await app.capture("bridge-custom");
  assert.match(opened, /→ vanilla\s+plain/, opened);
  assert.match(opened, /ctrl\+c closes/, opened);
  await press(app.terminal, DOWN, "→ pistachio");
  await app.terminal.submit();
  await app.terminal.waitText("flavour: pistachio");
  const closed = await app.terminal.text();
  assert.doesNotMatch(closed, /ctrl\+c closes/, closed);
  await app.close();
});

test("ctrl+c closes a component, and its command carries on with nothing chosen", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", CUSTOM] });
  await app.terminal.submit("/flavour");
  await app.terminal.waitText("pistachio");
  await app.terminal.write(CTRL_C);
  await app.terminal.waitText("flavour: none");
  await app.close();
});

test("a widget an extension builds from a component shows its rows", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", CUSTOM] });
  await app.terminal.submit("/gauge");
  await app.terminal.waitText("gauge ##########");
  await app.close();
});

test("a command that shows nothing says so", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", CUSTOM] });
  await app.terminal.submit("/quiet");
  await app.terminal.waitText("/quiet finished without showing anything");
  await app.close();
});

test("/reload reloads pi's extensions and keeps their commands", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions", "-e", CUSTOM] });
  await app.terminal.submit("/reload");
  await app.terminal.waitText("reloaded extensions");
  await app.terminal.submit("/flavour");
  await app.terminal.waitText("pistachio");
  await app.terminal.write(CTRL_C);
  await app.terminal.waitText("flavour: none");
  await app.close();
});

test("/changelog shows what changed in the running pi", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions"] });
  await app.terminal.submit("/changelog");
  await app.terminal.waitText("### ");
  await app.close();
});

test("/tree moves the session to another branch, reading the file without writing it", async () => {
  let file = "";
  const app = await launch({
    pi: ["--no-extensions"],
    argv: ["--continue"],
    prepare: (_home, sessions, cwd) => {
      const session = SessionManager.create(cwd, sessions);
      const root = session.appendMessage({
        role: "user",
        content: "shape the limits",
        timestamp: Date.now(),
      });
      session.appendMessage(reply("left branch answer"));
      session.branch(root);
      session.appendMessage(reply("right branch answer"));
      file = session.getSessionFile() ?? "";
    },
  });
  await app.terminal.waitText("right branch answer");
  const before = readFileSync(file, "utf8");
  await app.terminal.submit("/tree");
  await app.terminal.waitText("where the session stands");
  assert.equal(readFileSync(file, "utf8"), before);
  const tree = await app.capture("bridge-tree");
  assert.match(tree, /◆ pi: right branch answer/, tree);
  await press(app.terminal, "\x1b[A", "▸     pi: left branch answer");
  await app.terminal.submit();
  await app.terminal.waitText("move there, summarising");
  await app.terminal.submit();
  await app.terminal.waitText("left branch answer");
  const moved = await app.terminal.text();
  assert.doesNotMatch(moved, /right branch answer/, moved);
  await app.close();
});

test("a command that needs pi's own interface runs in stock pi, then pituitary carries on", async () => {
  const app = await launch({
    pi: ["--no-session", "--no-extensions"],
    // Stock pi asks whether to trust a project it has not seen; the operator's pi has answered.
    prepare: (home, _sessions, cwd) => {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "trust.json"), JSON.stringify({ [cwd]: true }));
    },
  });
  await app.terminal.submit("/logout");
  await app.terminal.waitText("press enter to run /logout");
  await app.capture("bridge-handoff");
  await app.terminal.write(CTRL_C);
  await app.terminal.write(CTRL_D);
  await app.terminal.waitText("Ask pi something to get started");
  await app.close();
});

test("after a hand-off, dialogs take the keys and one editor runs", async () => {
  const app = await launch({
    pi: ["--no-session", "--no-extensions", "-e", PROBE],
    prepare: (home, _sessions, cwd) => {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "trust.json"), JSON.stringify({ [cwd]: true }));
    },
  });
  await app.terminal.submit("/logout");
  await app.terminal.waitText("press enter to run /logout");
  await app.terminal.write(CTRL_C);
  await app.terminal.write(CTRL_D);
  await app.terminal.waitText("Ask pi something to get started");
  await app.terminal.submit("/probe");
  await app.terminal.waitText("Pick a colour");
  await pastGrace();
  await app.terminal.write(DOWN);
  await app.terminal.submit();
  await app.terminal.waitText("picked teal");
  await app.capture("bridge-handoff-dialog");
  const editors = survivors(app.home).filter((line) => line.includes("nvim") && line.includes("--embed"));
  assert.equal(editors.length, 1, editors.join("\n"));
  await app.close();
});

test("pi's own processes cannot see the bridge's socket or token", async () => {
  const app = await launch({ pi: ["--no-session", "--no-extensions"] });
  await app.terminal.submit("!printenv PITUITARY_BRIDGE PITUITARY_BRIDGE_TOKEN; echo printed-$?");
  await app.terminal.waitText("printed-1");
  await app.close();
});

test("a command that hands the session to pi waits while pi works", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write it");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("/login");
  await app.terminal.waitText("pi is working; wait for it to finish");
  await app.close();
});

test("/reload waits while pi works", async () => {
  const app = await launch({ scenario: "long", delayMs: 150 });
  await app.terminal.submit("write it");
  await app.terminal.waitText("line 1 of the long answer");
  await app.terminal.submit("/reload");
  await app.terminal.waitText("pi is working; wait for it to finish before reloading");
  await app.close();
});

test("a session pi has not saved is not handed over", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.submit("keep this");
  await app.terminal.waitText("You said: keep this");
  await app.terminal.submit("/logout");
  await app.terminal.waitText("this session is not saved yet");
  await app.close();
});
