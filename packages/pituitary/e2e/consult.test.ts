import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import {
  click,
  copied,
  pastGrace,
  press,
  RUNNING,
  survivors,
  unscrolled,
  waitGone,
  waitMatch,
} from "./helpers/harness.ts";
import { type ApiModel, launchPi, MODEL, type PiLaunch, type Received } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const CTRL_F = "\x06";
const CTRL_D = "\x04";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const BACKSPACE = "\x7f";
const ALT_O = "\x1bo";

/** The model the conversation is with, and those that weigh in on it. */
const MAIN: ApiModel = { id: "main", name: "Main" };
const REVIEWER: ApiModel = { id: "reviewer", name: "Reviewer" };
const SECOND: ApiModel = { id: "second", name: "Second" };

/** The requests the provider received for `model`, by its id. */
const requestsTo = (app: PiLaunch, model: ApiModel): Received[] =>
  app.provider.requests.filter((request) => request.body.model === model.id);

/** Every message text of a request, its system prompt among them, as one string. */
const said = (request: Received | undefined) => JSON.stringify(request?.body.messages ?? []);

/** Something the provider waits on until the test opens it. */
function gate() {
  let open = () => {};
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open };
}

/** A reply that streams its text and holds its end until released, keeping its model at work. */
function held(text: string) {
  const { until, open } = gate();
  return { reply: { text, until }, release: open };
}

/** The rows of the first card on `screen` whose title matches `title`, from its top rule to its bottom. */
function cardOn(screen: string, title: RegExp): string {
  const rows = screen.split("\n");
  const top = rows.findIndex((row) => title.test(row));
  assert.notEqual(top, -1, `no card titled ${title} on screen:\n${screen}`);
  const bottom = rows.findIndex((row, index) => index > top && row.includes("╰"));
  return rows.slice(top, bottom === -1 ? undefined : bottom + 1).join("\n");
}

/** The reviewer the scenarios declare, as Home Manager's `programs.pituitary.consult.models` would. */
const DECLARED = { PITUITARY_CONSULT_MODELS: `openai/${REVIEWER.id}` };

/** The list of models the operator chooses from. */
const LIST = "second opinion · tab marks several";

/** An extension's command, as the operator's own extensions bring, which a reviewer's Pi loads too. */
const NOTE = `export default function (pi) {
  pi.registerCommand("note", { description: "notes something down", handler: async () => {} });
}
`;

/**
 * A reviewer's Pi, which alone starts with --session-dir, writes `file`.taking as a prompt
 * reaches it, and takes the prompt only once `file` exists.
 */
const waitsFor = (file: string) => `import { existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  if (!process.argv.includes("--session-dir")) return;
  pi.on("input", async () => {
    writeFileSync(${JSON.stringify(`${file}.taking`)}, "");
    while (!existsSync(${JSON.stringify(file)})) await new Promise((resolve) => setTimeout(resolve, 20));
    return { action: "continue" };
  });
}
`;

/**
 * Resolves once `count` Pi processes run with the launch's HOME: its own, and a consultant's for
 * each card at work. Pi retitles its process `pi`.
 */
async function pisRunning(app: PiLaunch, count: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const running = survivors(app.home).filter((line) => /^\d+ pi$/.test(line));
    if (running.length === count) return;
    if (Date.now() - start > timeoutMs)
      throw new Error(`${running.length} Pi processes run, not ${count}:\n${running.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Resolves once `file` exists. */
async function exists(file: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Sends `prompt` to the conversation's model, which answers `reply`, and waits for `shown` of
 * the answer: its start unless said.
 */
async function turn(app: PiLaunch, prompt: string, reply: string, shown = reply.slice(0, 30)) {
  app.provider.replyTo(MAIN.id, reply);
  await app.terminal.submit(prompt);
  await app.terminal.waitText(shown);
  await app.terminal.waitIdle();
}

/** Opens the list of models with `open`, and takes the models it marks. */
async function consult(app: PiLaunch, open: () => Promise<void>) {
  await open();
  await app.terminal.waitText(LIST);
  await app.terminal.waitIdle();
  await app.terminal.keyboard.press("Enter");
  await waitGone(app.terminal, new RegExp(LIST));
}

test("a second opinion streams in a card, joins the conversation as an opinion the model reads next, and takes a reply", async () => {
  const app = await launchPi({
    apiModels: [MAIN, REVIEWER],
    env: DECLARED,
    extensions: { "note.ts": NOTE },
    record: true,
  });
  try {
    writeFileSync(join(app.cwd, "cache.ts"), "export const cache = new Map();\n");
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");

    const answer = held("Verdict: sound, but bound the cache's size.");
    app.provider.replyTo(REVIEWER.id, { tool: "read", arguments: { path: "cache.ts" } }, answer.reply);
    await app.terminal.submit("/consult is the cache plan sound?");
    await app.terminal.waitText(LIST);
    await app.terminal.waitIdle();
    const list = await app.capture("consult-list");
    // The declared reviewer is marked; the conversation's own model says so.
    assert.match(list, /◉ Reviewer/);
    assert.match(list, /○ Main .*this conversation's model/);
    await app.terminal.keyboard.press("Enter");

    // While the reviewer answers, its card shows its latest steps and its reply as it streams.
    await app.terminal.waitText("Verdict: sound");
    await waitMatch(app.terminal, /✓ \S+ read cache\.ts/);
    await app.terminal.waitIdle();
    const live = await app.capture("consult-live");
    assert.match(live, /╭─ ◆ Reviewer · \d+s · /);
    assert.match(live, /is the cache plan sound\?/);
    assert.match(live, /Reviewer weighing in/);

    const [asked] = requestsTo(app, REVIEWER);
    // The reviewer reads the conversation and the operator's question.
    assert.match(asked?.prompt ?? "", /plan the cache/);
    assert.match(asked?.prompt ?? "", /Use an LRU cache keyed by path\./);
    assert.match(asked?.prompt ?? "", /is the cache plan sound\?/);
    // It works read-only: it reads, and has no tool that writes, edits or runs a command.
    const tools = ((asked?.body.tools ?? []) as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    assert.ok(tools.includes("read"), tools.join(", "));
    for (const changing of ["write", "edit", "bash"]) assert.ok(!tools.includes(changing), tools.join(", "));

    answer.release();
    await app.terminal.waitText("Reviewer weighs in");
    await waitGone(app.terminal, /╭─ ◆ Reviewer/);
    await app.terminal.waitIdle();
    const recorded = await app.capture("consult-opinion");
    assert.match(
      recorded,
      /◆ Reviewer weighs in\n +is the cache plan sound\?\n\n +Verdict: sound, but bound the cache's size\./,
    );
    assert.match(recorded, /1 tool call/);

    // The model reads the opinion, by whom it is, with its next request.
    await turn(app, "go ahead", "Bounded it.");
    assert.match(said(requestsTo(app, MAIN).at(-1)), /Reviewer[^"]*Verdict: sound, but bound/);

    // On the opinion, c copies its answer, and a asks the agent to address it.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "a address · r reply");
    await app.capture("consult-opinion-cursor");
    await app.terminal.write("c");
    await app.terminal.waitText("copied the opinion");
    assert.equal(copied(app.raw()), "Verdict: sound, but bound the cache's size.");
    // The hint stands in for the cursor's keys until it passes.
    await waitGone(app.terminal, /copied the opinion/);
    app.provider.replyTo(MAIN.id, "Agreed; the bound stays.");
    await app.terminal.write("a");
    await app.terminal.waitText("Agreed; the bound stays.");
    await app.terminal.waitIdle();
    assert.match(requestsTo(app, MAIN).at(-1)?.prompt ?? "", /Address the second opinion from Reviewer/);

    // r asks the reviewer a follow-up in its own session, and the answer records as a new opinion.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "a address · r reply");
    await app.terminal.write("r");
    await app.terminal.waitText("Reply to Reviewer");
    await pastGrace();
    app.provider.replyTo(REVIEWER.id, "A thousand entries is plenty.");
    await app.terminal.type("how big a bound?");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("A thousand entries is plenty.");
    await app.terminal.waitIdle();
    const followed = unscrolled(await app.capture("consult-follow-up"));
    assert.match(followed, /◆ Reviewer weighs in *\n +how big a bound\?/);
    // It called no tool, which its opinion leaves unsaid.
    assert.doesNotMatch(followed, /0 tool calls/);
    const followUp = requestsTo(app, REVIEWER).at(-1);
    assert.equal(followUp?.prompt, "how big a bound?");
    // It continues its own session: its first answer is among what it reads.
    assert.match(said(followUp), /Verdict: sound, but bound/);

    // A follow-up Pi takes for an extension's command asks the reviewer nothing, and its card says so.
    const asks = requestsTo(app, REVIEWER).length;
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "a address · r reply");
    await app.terminal.write("r");
    await app.terminal.waitText("Reply to Reviewer");
    await pastGrace();
    await app.terminal.type("/note is the bound right?");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /╭─ ◆ Reviewer · failed/);
    await app.terminal.waitText("Pi ran that as a command of its own, so nothing was asked.");
    await app.terminal.waitIdle();
    await app.capture("consult-follow-up-command");
    assert.equal(requestsTo(app, REVIEWER).length, asks);
  } finally {
    await app.close();
  }
});

test("opinions that settle while the agent works wait on cards titled at any width, the run reads them as its turn ends, and a steers it", async () => {
  // Names as long as real ones, whose cards' titles are cut to fit.
  const HAIKU: ApiModel = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" };
  const LONG: ApiModel = { id: "long", name: "Second Opinion Model With A Long Name" };
  const app = await launchPi({
    cols: 160,
    rows: 45,
    apiModels: [MAIN, HAIKU, LONG],
    env: { PITUITARY_CONSULT_MODELS: `openai/${HAIKU.id},openai/${LONG.id}` },
  });
  writeFileSync(join(app.cwd, "cache.ts"), "export const cache = new Map();\n");
  const first = gate();
  const second = gate();
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    // The agent's run reads a file and then another, each held back by the provider, then answers.
    app.provider.replyTo(
      MAIN.id,
      { tool: "read", arguments: { path: "cache.ts" }, until: first.until },
      { tool: "read", arguments: { path: "cache.ts" }, until: second.until },
      "Bounded the cache, as the reviewers said.",
    );
    await app.terminal.submit("write it");
    await waitMatch(app.terminal, RUNNING);
    app.provider.replyTo(HAIKU.id, "Bound it.");
    app.provider.replyTo(LONG.id, "Bound it at a thousand entries.");
    await consult(app, () => app.terminal.submit("/consult"));
    await waitMatch(app.terminal, /recorded · joins as the turn ends[\s\S]*recorded · joins as the turn/);
    await app.terminal.waitIdle();
    const beside = await app.capture("consult-recorded-beside");
    assert.match(
      beside,
      /╭─ ◆ Claude Haiku 4\.5 · recorded[^\n]*╭─ ◆ Second Opinion Model With A Long Name · /,
    );
    assert.match(beside, /Bound it at a thousand entries\./);
    assert.doesNotMatch(beside, /weighs in/);
    // Recorded answers join all the same, so /consult cancel has nothing to stop and leaves them.
    await app.terminal.submit("/consult cancel");
    await app.terminal.waitText("No second opinion is under way.");
    assert.match(
      await app.terminal.text(),
      /recorded · joins as the turn ends[\s\S]*recorded · joins as the turn/,
    );

    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /╭─ ◆ Claude Haiku 4\.5 · recorded[^\n]*\n[\s\S]*╭─ ◆ Second Opinion/);
    await app.terminal.waitIdle();
    const narrow = await app.capture("consult-recorded-80");
    assert.match(narrow, /╭─ ◆ Second Opinion Model With A Long Name · recorded/);

    await app.terminal.resize(100, 28);
    first.open();
    await app.terminal.waitText("Second Opinion Model With A Long Name weighs in");
    await waitGone(app.terminal, /╭─ ◆ /);
    await app.terminal.waitIdle();

    // While the run reads its second file, a on an opinion steers the run to address it.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("a address · r reply");
    await app.capture("consult-steer-cursor");
    await app.terminal.write("a");
    await waitGone(app.terminal, /a address · r reply/);
    second.open();
    await app.terminal.waitText("Bounded the cache, as the reviewers said.");
    await app.terminal.waitIdle();
    const joined = await app.capture("consult-joined-run");
    // The opinions join after the first read, the steer after the second, and the run's answer
    // follows it: nothing waited for the run to end, and nothing runs after it.
    assert.match(
      joined,
      /◆ Second Opinion Model With A Long Name weighs in[\s\S]*▸ \S+ read cache\.ts[\s\S]*▌ Address the second opinion from [\s\S]*● Bounded the cache, as the reviewers said\./,
    );
    assert.doesNotMatch(joined, /Reply to:/);
    const [read, addressed] = requestsTo(app, MAIN).slice(-2);
    // The run's request after the turn the opinions joined read them, by whom each is.
    assert.match(said(read), /Claude Haiku 4\.5[^"]*Bound it\./);
    assert.match(said(read), /Second Opinion Model With A Long Name[^"]*Bound it at a thousand entries\./);
    // The one after it, which the run's answer answered, read the operator's steer.
    assert.match(
      addressed?.prompt ?? "",
      /Address the second opinion from (Claude Haiku 4\.5|Second Opinion Model With A Long Name) above/,
    );
  } finally {
    first.open();
    second.open();
    await app.close();
  }
});

test("a long conversation reaches the reviewer trimmed to its context window, its latest turns whole", async () => {
  const app = await launchPi({
    apiModels: [MAIN, { ...REVIEWER, contextWindow: 6000 }],
    env: DECLARED,
    // The reviewer's small window would otherwise have Pi compact its session as it answers.
    settings: { compaction: { enabled: false } },
  });
  try {
    const filler = "the cache holds an entry for each path it has read ".repeat(75);
    // Each reply runs longer than the screen, so its end says it has arrived.
    for (let step = 1; step <= 6; step++)
      await turn(app, `step ${step}`, `TURN-${step} ${filler}END-${step}`, `END-${step}`);
    app.provider.replyTo(REVIEWER.id, "Looks fine.");
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Reviewer weighs in");
    await app.terminal.waitIdle();
    // The question the operator did not write is named on one row.
    assert.match(
      unscrolled(await app.capture("consult-trimmed")),
      /◆ Reviewer weighs in *\n +\S[^\n]*\n *\n +Looks fine\./,
    );

    const main = said(requestsTo(app, MAIN).at(-1));
    const [request] = requestsTo(app, REVIEWER);
    const prompt = request?.prompt ?? "";
    assert.ok(main.length > 20_000, `the conversation holds ${main.length} characters`);
    // The latest turns arrive whole, their prompts and their replies to the end, and the oldest are left out.
    for (const step of [5, 6]) {
      assert.ok(prompt.includes(`step ${step}`), `step ${step} is not among what the reviewer read`);
      assert.ok(prompt.includes(`TURN-${step} ${filler}END-${step}`), `turn ${step} did not arrive whole`);
    }
    assert.doesNotMatch(prompt, /TURN-1 |TURN-2 /);
    // Everything the reviewer is sent, its tools too, fits its 6000 tokens at four characters a token.
    const sent = said(request).length + JSON.stringify(request?.body.tools ?? []).length;
    assert.ok(sent < 6000 * 4, `the reviewer was sent ${sent} characters`);
  } finally {
    await app.close();
  }
});

test("the reviewer takes the operator's own extensions, found from where Pituitary started, and context-file choice but not their other flags, and keeps its session apart", async () => {
  // A session of another project, which the operator resumes from the one Pituitary starts in.
  const first = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED, project: "elsewhere" });
  let again: PiLaunch | undefined;
  try {
    await turn(first, "plan the cache", "Use an LRU cache keyed by path.");
    await first.terminal.write(CTRL_D);
    await first.terminal.waitText("Resume: pituitary --session");
    // A context file Pi would read where the session works, but for the operator's --no-context-files.
    writeFileSync(join(first.cwd, "AGENTS.md"), "CONTEXT-FILE-MARKER\n");
    // The operator's extension, named from the project Pituitary starts in, where the session does not work.
    const here = join(first.home, "sample");
    mkdirSync(here, { recursive: true });
    writeFileSync(
      join(here, "marker.ts"),
      `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nOPERATOR-EXTENSION-MARKER" }));
}
`,
    );
    const app = await launchPi({
      from: first,
      apiModels: [MAIN, REVIEWER],
      env: DECLARED,
      argv: [
        "--resume",
        "--no-context-files",
        "-e",
        "marker.ts",
        "--append-system-prompt",
        "MAIN-ONLY-INSTRUCTIONS",
      ],
    });
    again = app;
    await app.terminal.waitText("resume · every project's sessions");
    await app.terminal.waitIdle();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Working in ~/elsewhere, where this session started");
    await turn(app, "bound it?", "Bounded.");
    app.provider.replyTo(REVIEWER.id, "Sound.");
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Reviewer weighs in");
    await app.terminal.waitIdle();

    const main = said(requestsTo(app, MAIN).at(-1));
    const reviewer = said(requestsTo(app, REVIEWER)[0]);
    assert.match(main, /OPERATOR-EXTENSION-MARKER/);
    assert.match(main, /MAIN-ONLY-INSTRUCTIONS/);
    assert.match(reviewer, /OPERATOR-EXTENSION-MARKER/);
    assert.doesNotMatch(reviewer, /CONTEXT-FILE-MARKER/);
    assert.doesNotMatch(reviewer, /MAIN-ONLY-INSTRUCTIONS/);

    // The reviewer's session is among the consultants', never Pi's own, which the resume list shows.
    assert.equal(app.consultSessions().length, 1);
    assert.equal(app.sessions().length, 1);
    await app.terminal.submit("/resume all");
    await app.terminal.waitText("resume · every project's sessions");
    await app.terminal.waitIdle();
    const resume = await app.capture("consult-resume-list");
    assert.match(resume, /plan the cache/);
    assert.doesNotMatch(resume, /second opinion/);
  } finally {
    await again?.close();
    await first.close();
  }
});

test("alt+o, which the welcome offers, asks about the draft, which empties once the models are chosen, and w asks about a reply its opinion names", async () => {
  const app = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED });
  try {
    assert.match(await app.capture("consult-welcome"), /alt\+o +.*ask for a second opinion/);
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.\n\nEvict the oldest entry first.");
    await app.terminal.type("is the eviction order right?");
    await app.terminal.write(ALT_O);
    await app.terminal.waitText(LIST);
    await app.terminal.waitIdle();
    // Closing the list, as a quick esc then o might open it, leaves the draft as it was.
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, new RegExp(LIST));
    await app.terminal.waitText("» is the eviction order right?");
    app.provider.replyTo(REVIEWER.id, "The order is right.");
    await consult(app, () => app.terminal.write(ALT_O));
    await app.terminal.waitText("The order is right.");
    await app.terminal.waitText("» ask pi");
    assert.match(requestsTo(app, REVIEWER)[0]?.prompt ?? "", /is the eviction order right\?/);

    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "w weigh in");
    await app.capture("consult-reply-cursor");
    app.provider.replyTo(REVIEWER.id, "Evicting the oldest is right for this load.");
    await consult(app, () => app.terminal.write("w"));
    await app.terminal.waitText("Evicting the oldest is right for this load.");
    await app.terminal.waitIdle();
    // The reviewer is asked about the reply, which its question quotes beside the conversation's own copy.
    const weighed = requestsTo(app, REVIEWER).at(-1)?.prompt ?? "";
    for (const line of ["Use an LRU cache keyed by path.", "Evict the oldest entry first."])
      assert.ok(weighed.split(line).length - 1 >= 2, `the question does not quote "${line}":\n${weighed}`);
    // The opinion says which reply it weighs in on, by its first line.
    assert.match(
      unscrolled(await app.capture("consult-weighed")),
      /◆ Reviewer weighs in *\n +on “Use an LRU cache keyed by path\.” *\n/,
    );
  } finally {
    await app.close();
  }
});

test("alt+o bound to open every box does that, and the welcome no longer offers a second opinion", async () => {
  const app = await launchPi({
    apiModels: [MAIN, REVIEWER],
    env: DECLARED,
    keybindings: { "app.tools.expand": "alt+o" },
  });
  try {
    const welcome = await app.capture("consult-welcome-rebound");
    assert.match(welcome, /alt\+o +open every box/);
    assert.doesNotMatch(welcome, /second opinion/);
    writeFileSync(join(app.cwd, "cache.ts"), "export const cache = new Map();\n");
    app.provider.replyTo(MAIN.id, { tool: "read", arguments: { path: "cache.ts" } }, "Read it.");
    await app.terminal.submit("read the cache");
    await app.terminal.waitText("Read it.");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.terminal.text(), /export const cache/);
    await app.terminal.write(ALT_O);
    await app.terminal.waitText("export const cache = new Map();");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.capture("consult-rebound-expanded"), new RegExp(LIST));
  } finally {
    await app.close();
  }
});

test("reviewers stand side by side where each has 60 columns and stacked where not, show the latest of a long answer, and stop only for x or /consult cancel", async () => {
  const app = await launchPi({
    cols: 160,
    rows: 45,
    apiModels: [MAIN, REVIEWER, SECOND],
    env: { PITUITARY_CONSULT_MODELS: `openai/${REVIEWER.id},openai/${SECOND.id}` },
  });
  const points = Array.from({ length: 30 }, (_, index) => `- Point ${index + 1} about the cache.`);
  const first = held(["Bound the cache before it grows.", "", ...points].join("\n"));
  const second = held("Shard the cache by directory.");
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    app.provider.replyTo(REVIEWER.id, first.reply);
    app.provider.replyTo(SECOND.id, second.reply);
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Point 30 about the cache.");
    await app.terminal.waitText("Shard the cache by directory.");
    await app.terminal.waitIdle();
    const beside = await app.capture("consult-beside");
    assert.match(beside, /╭─ ◆ Reviewer · [^\n]*╭─ ◆ Second · /);
    assert.match(beside, /◆ 2 models weighing in/);
    // A long answer shows its latest rows after how many came before, leaving the operator's prompt in view.
    assert.match(beside, /… \d+ earlier lines/);
    assert.doesNotMatch(beside, /Point 1 about/);
    assert.match(beside, /▌ plan the cache/);
    // Each reviewer answers in a Pi of its own, beside the conversation's.
    await pisRunning(app, 3);

    // Plain esc, pressed again and again, leaves them answering.
    for (let press = 0; press < 3; press++) await app.terminal.keyboard.press("Escape");
    await app.terminal.waitIdle();
    await app.terminal.resize(100, 28);
    await waitMatch(app.terminal, /╭─ ◆ Reviewer · [^\n]*\n[\s\S]*╭─ ◆ Second · /);
    await app.terminal.waitIdle();
    const stacked = await app.capture("consult-stacked");
    assert.match(stacked, /╭─ ◆ Reviewer · [^\n]*\n[\s\S]*╭─ ◆ Second · /);
    assert.doesNotMatch(stacked, /╭─ ◆ Reviewer · [^\n]*╭─ ◆ Second/);

    // The cursor starts on the conversation's latest item, the cards a move below it, where esc only leaves.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("w weigh in");
    await press(app.terminal, DOWN, "x cancel");
    await app.capture("consult-card-cursor");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /x cancel/);
    assert.match(await app.terminal.text(), /╭─ ◆ Reviewer · [\s\S]*╭─ ◆ Second · /);

    // x on a card stops that one alone, its Pi ends, and it says so.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("w weigh in");
    await press(app.terminal, DOWN, "x cancel");
    await app.terminal.write("x");
    await waitGone(app.terminal, /╭─ ◆ Reviewer/);
    await app.terminal.waitText("cancelled Reviewer's second opinion");
    await app.terminal.waitText("╭─ ◆ Second · ");
    await pisRunning(app, 2);
    first.release();
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("◆ Second weighing in");
    assert.match(await app.capture("consult-one-cancelled"), /╭─ ◆ Second · /);
    await app.terminal.submit("/consult cancel");
    await waitGone(app.terminal, /╭─ ◆ Second/);
    await app.terminal.waitText("cancelled 1 second opinion");
    await pisRunning(app, 1);
    second.release();
    assert.doesNotMatch(await app.capture("consult-cancelled"), /weighing in|weighs in/);
    // What the cancelled reviewers would have answered never joins the conversation.
    await turn(app, "carry on", "Carrying on.");
    assert.doesNotMatch(await app.terminal.text(), /weighs in/);
    assert.doesNotMatch(
      said(requestsTo(app, MAIN).at(-1)),
      /Bound the cache before it grows|Shard the cache/,
    );
  } finally {
    first.release();
    second.release();
    await app.close();
  }
});

test("a reviewer that cannot answer says why on its card, in Pi's words, until cleared or the next prompt", async () => {
  const unsigned = `openai-codex/${MODEL}`;
  const app = await launchPi({
    apiModels: [MAIN],
    // One Pi does not know, one it is not signed in to, and one that names no provider.
    env: { PITUITARY_CONSULT_MODELS: `missing/reviewer,${unsigned},gpt-5` },
    record: true,
  });
  try {
    // An empty conversation has nothing to consult on, so no list opens.
    await app.terminal.submit("/consult");
    await app.terminal.waitText("There is nothing to consult on yet: ask something first.");
    assert.doesNotMatch(await app.terminal.text(), new RegExp(LIST));
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");

    // A model that names no provider cannot be asked: picked alone, it warns and keeps the draft.
    await app.terminal.type("is it sound?");
    await app.terminal.write(ALT_O);
    await app.terminal.waitText("declared · not provider/id");
    await app.terminal.waitIdle();
    await app.capture("consult-failed-list");
    await press(app.terminal, TAB, "▶ ○ missing/reviewer");
    await press(app.terminal, DOWN, `▶ ◉ ${unsigned}`);
    await press(app.terminal, TAB, `▶ ○ ${unsigned}`);
    await press(app.terminal, DOWN, "▶ ○ Main");
    await press(app.terminal, DOWN, "▶ ○ gpt-5");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("name gpt-5 as provider/id to ask it");
    await app.terminal.waitText("» is it sound?");
    assert.doesNotMatch(await app.terminal.text(), /╭─ ◆ /);

    await consult(app, () => app.terminal.write(ALT_O));
    await app.terminal.waitText('Unknown provider "missing"');
    await app.terminal.waitText("No API key found for openai-codex");
    await app.terminal.waitIdle();
    const failed = await app.capture("consult-failed");
    assert.match(failed, /╭─ ◆ missing\/reviewer · failed/);
    assert.match(failed, /Pi exited \(1\)/);
    assert.match(failed, new RegExp(`╭─ ◆ ${unsigned.replace(".", "\\.")} · failed`));
    // A failed card says how it goes.
    assert.match(cardOn(failed, /╭─ ◆ missing\/reviewer/), /next prompt/);

    // Under the cursor a failed card's c copies why it failed, and x clears it.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, DOWN, "x clear");
    await app.terminal.write("c");
    await app.terminal.waitText("copied the second opinion so far");
    assert.match(copied(app.raw()), /Unknown provider "missing"/);
    await app.terminal.write("x");
    await waitGone(app.terminal, /Unknown provider "missing"/);
    await app.terminal.waitText("cleared missing/reviewer's second opinion");
    await app.terminal.keyboard.press("Escape");

    // The next prompt clears the one left.
    await turn(app, "carry on", "Carrying on.");
    await waitGone(app.terminal, /No API key found for openai-codex/);

    // /consult cancel clears cards that failed, and says it cleared them.
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText('Unknown provider "missing"');
    await app.terminal.waitText("No API key found for openai-codex");
    await app.terminal.submit("/consult cancel");
    await app.terminal.waitText("cleared 2 second opinions that failed");
    await waitGone(app.terminal, /╭─ ◆ /);
    // A consultant whose prompt Pi refused leaves nothing waiting on it once its card goes.
    assert.doesNotMatch(readFileSync(join(app.home, "tui.log"), "utf8"), /unhandled rejection/);
  } finally {
    await app.close();
  }
});

test("an opinion about a point of the tree the session has since left is not recorded, and w and a wait while the move summarizes", async () => {
  const app = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED });
  const answer = held("Verdict: beta is right.");
  const summary = held("The branch asked beta.");
  try {
    await turn(app, "alpha", "Alpha answer.");
    await turn(app, "beta", "Beta answer.");
    app.provider.replyTo(REVIEWER.id, "Beta holds up.");
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Reviewer weighs in");
    app.provider.replyTo(REVIEWER.id, answer.reply);
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Verdict: beta is right.");

    // Back before beta, summarizing the branch it leaves, which the provider holds.
    app.provider.replyTo(MAIN.id, summary.reply);
    await app.terminal.submit("/tree");
    await app.terminal.waitText("tree · move to another point of this session");
    await app.terminal.waitIdle();
    await press(app.terminal, UP, "▶ ▌ beta");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Summarize the branch you leave?");
    await pastGrace();
    await press(app.terminal, DOWN, "▶ Summarize");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("summarizing the branch you leave");

    // Pi would answer on the branch the move leaves, so a on the opinion and w on a reply wait, as the draft does.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("a address · r reply");
    await app.terminal.write("a");
    await app.terminal.waitText("the draft waits for the branch summary");
    await waitGone(app.terminal, /the draft waits for the branch summary/);
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "w weigh in");
    await app.terminal.write("w");
    await app.terminal.waitText("the draft waits for the branch summary");
    assert.doesNotMatch(await app.terminal.text(), new RegExp(LIST));
    summary.release();
    await waitGone(app.terminal, /summarizing the branch you leave/);
    await app.terminal.keyboard.press("Escape");
    await waitMatch(app.terminal, /» beta/);

    answer.release();
    await waitMatch(app.terminal, /╭─ ◆ Reviewer · failed/);
    await app.terminal.waitText("Not recorded");
    await app.terminal.waitIdle();
    const refused = await app.capture("consult-not-recorded");
    // The card keeps the answer, which joins no conversation.
    assert.match(cardOn(refused, /╭─ ◆ Reviewer/), /Verdict: beta is right\./);
    assert.doesNotMatch(refused, /weighs in/);
    // Nor did the agent hear of the opinion on the branch the move left.
    assert.doesNotMatch(refused, /Address the second opinion/);
    assert.ok(requestsTo(app, MAIN).every((request) => !/Address the second opinion/.test(request.prompt)));
  } finally {
    answer.release();
    summary.release();
    await app.close();
  }
});

test("under --no-session, with no models declared, tab and a click mark several, a reviewer's dialog is cancelled for it, and the next list starts with the last choice", async () => {
  // Only a reviewer's Pi starts with --session-dir; the question it asks has nobody to answer it.
  const asks = `export default function (pi) {
  if (!process.argv.includes("--session-dir")) return;
  pi.on("before_agent_start", async (event, ctx) => {
    const yes = await ctx.ui.confirm("Review?", "Nobody is there to answer.");
    return { systemPrompt: event.systemPrompt + (yes ? "\\nDIALOG-CONFIRMED" : "\\nDIALOG-CANCELLED") };
  });
}
`;
  const app = await launchPi({
    apiModels: [MAIN, REVIEWER, SECOND],
    argv: ["--no-session"],
    extensions: { "asks.ts": asks },
  });
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    await app.terminal.submit("/consult");
    await app.terminal.waitText(LIST);
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.terminal.text(), /◉/);
    // Tab marks the highlighted model, leaving the filter its words.
    // Pi lists its catalog's models for the provider besides those the scenario declares.
    await app.terminal.type("rev");
    await waitMatch(app.terminal, / 1 of \d+/);
    await app.terminal.write(TAB);
    await app.terminal.waitText("◉ Reviewer");
    await app.terminal.write(BACKSPACE.repeat(3));
    await app.terminal.waitText("type to narrow");
    await app.terminal.type("sec ond");
    await waitMatch(app.terminal, /▶ ○ Second[\s\S]* 1 of \d+/);
    await app.terminal.write(TAB);
    await app.terminal.waitText("enter pick 2");
    // Marked, enter picks them though nothing matches the filter.
    await app.terminal.type("zzz");
    await app.terminal.waitText("nothing matches");
    await app.capture("consult-marked");
    app.provider.replyTo(REVIEWER.id, "Reviewed: sound.");
    app.provider.replyTo(SECOND.id, "Seconded: sound.");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reviewer weighs in");
    await app.terminal.waitText("Second weighs in");
    await app.terminal.waitIdle();
    await app.capture("consult-no-session");
    // The reviewer's extension asked, and the question was cancelled for it.
    assert.match(said(requestsTo(app, REVIEWER)[0]), /DIALOG-CANCELLED/);

    // The next list starts with the models chosen last; a click marks a row, as tab does.
    await app.terminal.submit("/consult");
    await app.terminal.waitText(LIST);
    await app.terminal.waitIdle();
    const again = await app.capture("consult-last-choice");
    assert.match(again, /◉ Reviewer/);
    assert.match(again, /◉ Second/);
    const rows = again.split("\n");
    const main = rows.findIndex((row) => row.includes("○ Main"));
    await click(app.terminal, (rows[main] ?? "").indexOf("Main"), main);
    await app.terminal.waitText("◉ Main");
    await app.terminal.waitText("enter pick 3");
    assert.match(await app.terminal.text(), new RegExp(LIST));
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, new RegExp(LIST));
  } finally {
    await app.close();
  }
});

test("an opinion stays in Pi's record of the session, and a reply after a restart continues the reviewer's own session", async () => {
  const app = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED });
  let again: PiLaunch | undefined;
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    app.provider.replyTo(REVIEWER.id, "Verdict: sound.");
    await consult(app, () => app.terminal.submit("/consult is it sound?"));
    await app.terminal.waitText("Reviewer weighs in");
    await app.terminal.waitIdle();

    // Away to a new session and back through /resume, the opinion is drawn from Pi's record.
    await app.terminal.submit("/new");
    await waitGone(app.terminal, /Reviewer weighs in/);
    await app.terminal.submit("/resume");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitIdle();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reviewer weighs in");
    await app.terminal.waitIdle();
    assert.match(
      unscrolled(await app.capture("consult-resumed")),
      /◆ Reviewer weighs in *\n +is it sound\? *\n *\n +Verdict: sound\./,
    );

    const [file] = app.sessions();
    await app.terminal.write(CTRL_D);
    await app.terminal.waitText("Resume: pituitary --session");
    const asked = join(app.home, "take-the-prompt");
    again = await launchPi({
      from: app,
      apiModels: [MAIN, REVIEWER],
      argv: ["--session", file as string],
      extensions: { "waits.ts": waitsFor(asked) },
    });
    await again.terminal.waitText("Reviewer weighs in");
    await again.terminal.waitIdle();
    await again.terminal.write(CTRL_F);
    await again.terminal.waitText("a address · r reply");
    await again.terminal.write("r");
    await again.terminal.waitText("Reply to Reviewer");
    await pastGrace();
    app.provider.replyTo(REVIEWER.id, "A thousand entries.");
    await again.terminal.type("and the size?");
    await again.terminal.keyboard.press("Enter");
    // Its Pi up on its session and the question not yet taken, its card shows the question alone,
    // not the answer to the one before.
    await exists(`${asked}.taking`);
    await waitMatch(again.terminal, /╭─ ◆ Reviewer · starting/);
    await again.terminal.waitIdle();
    const starting = cardOn(await again.capture("consult-restarting"), /╭─ ◆ Reviewer · starting/);
    assert.match(starting, /and the size\?/);
    assert.doesNotMatch(starting, /Verdict: sound\./);
    writeFileSync(asked, "");
    await again.terminal.waitText("A thousand entries.");
    await again.terminal.waitIdle();
    await again.capture("consult-restarted-reply");
    const followUp = requestsTo(again, REVIEWER).at(-1);
    assert.equal(followUp?.prompt, "and the size?");
    assert.match(said(followUp), /Verdict: sound\./);
    assert.equal(again.consultSessions().length, 1);
  } finally {
    await again?.close();
    await app.close();
  }
});
