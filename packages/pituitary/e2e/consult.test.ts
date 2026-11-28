import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { pastGrace, press, RUNNING, unscrolled, waitGone, waitMatch } from "./helpers/harness.ts";
import { type ApiModel, launchPi, type PiLaunch, type Received } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const CTRL_F = "\x06";
const CTRL_D = "\x04";
const UP = "\x1b[A";
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

/** A reply that streams its text and holds its end until released, keeping its model at work. */
function held(text: string) {
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reply: { text, until }, release };
}

/** The reviewer the scenarios declare, as Home Manager's `programs.pituitary.consult.models` would. */
const DECLARED = { PITUITARY_CONSULT_MODELS: `openai/${REVIEWER.id}` };

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
  await app.terminal.waitText("second opinion · space marks several");
  await app.terminal.waitIdle();
  await app.terminal.keyboard.press("Enter");
  await waitGone(app.terminal, /second opinion · space marks several/);
}

test("a second opinion streams in a card, joins the conversation as an opinion the model reads next, and takes a reply", async () => {
  const app = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED });
  try {
    writeFileSync(join(app.cwd, "cache.ts"), "export const cache = new Map();\n");
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");

    const answer = held("Verdict: sound, but bound the cache's size.");
    app.provider.replyTo(REVIEWER.id, { tool: "read", arguments: { path: "cache.ts" } }, answer.reply);
    await app.terminal.submit("/consult is the cache plan sound?");
    await app.terminal.waitText("second opinion · space marks several");
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
    // The reviewer reads the conversation and the question, and works read-only.
    assert.match(asked?.prompt ?? "", /\[User\]: plan the cache/);
    assert.match(asked?.prompt ?? "", /\[Assistant\]: Use an LRU cache keyed by path\./);
    assert.match(asked?.prompt ?? "", /The operator's question: is the cache plan sound\?/);
    const tools = ((asked?.body.tools ?? []) as { function: { name: string } }[]).map(
      (tool) => tool.function.name,
    );
    assert.deepEqual(tools.sort(), ["find", "grep", "ls", "read"]);

    answer.release();
    await app.terminal.waitText("Reviewer weighs in");
    await waitGone(app.terminal, /╭─ ◆ Reviewer/);
    await app.terminal.waitIdle();
    const recorded = await app.capture("consult-opinion");
    assert.match(
      recorded,
      /◆ Reviewer weighs in\n +is the cache plan sound\?\n\n +Verdict: sound, but bound the cache's size\./,
    );
    assert.match(recorded, /1 tool call · \$0\.00/);

    // The model reads the opinion with its next request.
    await turn(app, "go ahead", "Bounded it.");
    assert.match(
      said(requestsTo(app, MAIN).at(-1)),
      /Second opinion from Reviewer[^"]*Verdict: sound, but bound/,
    );

    // On the opinion, a asks the agent to address it.
    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "a address · r reply");
    await app.capture("consult-opinion-cursor");
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
    assert.match(
      unscrolled(await app.capture("consult-follow-up")),
      /◆ Reviewer weighs in *\n +how big a bound\?/,
    );
    const followUp = requestsTo(app, REVIEWER).at(-1);
    assert.equal(followUp?.prompt, "how big a bound?");
    // It continues its own session: its first answer is among what it reads.
    assert.match(said(followUp), /Verdict: sound, but bound/);
  } finally {
    await app.close();
  }
});

test("an opinion that settles while the agent works waits on its card, and the run reads it as its turn ends", async () => {
  const app = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED });
  writeFileSync(join(app.cwd, "cache.ts"), "export const cache = new Map();\n");
  let release = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    // The agent's run reads a file, which the provider holds back, then answers.
    app.provider.replyTo(
      MAIN.id,
      { tool: "read", arguments: { path: "cache.ts" }, until },
      "Bounded the cache, as the reviewer said.",
    );
    await app.terminal.submit("write it");
    await waitMatch(app.terminal, RUNNING);
    app.provider.replyTo(REVIEWER.id, "Bound it.");
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("recorded · it joins the conversation as the turn ends");
    await app.terminal.waitIdle();
    const waiting = await app.capture("consult-recorded-waiting");
    assert.match(waiting, /Bound it\./);
    assert.doesNotMatch(waiting, /weighs in/);

    release();
    await app.terminal.waitText("Bounded the cache, as the reviewer said.");
    await waitGone(app.terminal, /╭─ ◆ Reviewer/);
    await app.terminal.waitIdle();
    assert.match(
      await app.capture("consult-joined-run"),
      /◆ Reviewer weighs in[\s\S]*● Bounded the cache, as the reviewer said\./,
    );
    // The run's next request read the opinion, as it would a steer.
    assert.match(said(requestsTo(app, MAIN).at(-1)), /Second opinion from Reviewer[^"]*Bound it\./);
  } finally {
    release();
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
    await app.capture("consult-trimmed");

    const main = said(requestsTo(app, MAIN).at(-1));
    const { prompt } = requestsTo(app, REVIEWER)[0] ?? { prompt: "" };
    assert.ok(main.length > 20_000, `the conversation holds ${main.length} characters`);
    // The latest turns arrive whole, the oldest are left out and say so, and the default question is asked.
    for (const step of [5, 6])
      assert.match(prompt, new RegExp(`\\[User\\]: step ${step}\\n\\n\\[Assistant\\]: TURN-${step} `));
    assert.doesNotMatch(prompt, /TURN-1 |TURN-2 /);
    assert.match(prompt, /\[\d earlier turns left out\]/);
    assert.match(prompt, /The operator's question: Review the conversation so far/);
    // Half the reviewer's 6000 tokens, at four characters a token, and the question's frame.
    assert.ok(prompt.length < 12_000 + 1_500, `the reviewer read ${prompt.length} characters`);
  } finally {
    await app.close();
  }
});

test("the reviewer takes the operator's own extensions and context-file choice but not their other flags, and keeps its session apart", async () => {
  const scratch = mkdtempSync("/tmp/pituitary-consult-");
  const extension = join(scratch, "marker.ts");
  writeFileSync(
    extension,
    `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nOPERATOR-EXTENSION-MARKER" }));
}
`,
  );
  const app = await launchPi({
    apiModels: [MAIN, REVIEWER],
    env: DECLARED,
    argv: ["--no-context-files", "-e", extension, "--append-system-prompt", "MAIN-ONLY-INSTRUCTIONS"],
  });
  try {
    // A context file Pi would read, but for the operator's --no-context-files.
    writeFileSync(join(app.cwd, "AGENTS.md"), "CONTEXT-FILE-MARKER\n");
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    app.provider.replyTo(REVIEWER.id, "Sound.");
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Reviewer weighs in");
    await app.terminal.waitIdle();

    const main = said(requestsTo(app, MAIN)[0]);
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
    await app.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("alt+o asks about the draft, which empties once the models are chosen, and w asks about a reply", async () => {
  const app = await launchPi({ apiModels: [MAIN, REVIEWER], env: DECLARED });
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.\n\nEvict the oldest entry first.");
    await app.terminal.type("is the eviction order right?");
    await app.terminal.write(ALT_O);
    await app.terminal.waitText("second opinion · space marks several");
    await app.terminal.waitIdle();
    // Closing the list, as a quick esc then o might open it, leaves the draft as it was.
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /second opinion · space marks several/);
    await app.terminal.waitText("» is the eviction order right?");
    app.provider.replyTo(REVIEWER.id, "The order is right.");
    await consult(app, () => app.terminal.write(ALT_O));
    await app.terminal.waitText("The order is right.");
    await app.terminal.waitText("» ask pi");
    assert.match(
      requestsTo(app, REVIEWER)[0]?.prompt ?? "",
      /The operator's question: is the eviction order right\?/,
    );

    await app.terminal.write(CTRL_F);
    await press(app.terminal, UP, "w weigh in");
    await app.capture("consult-reply-cursor");
    app.provider.replyTo(REVIEWER.id, "Evicting the oldest is right for this load.");
    await consult(app, () => app.terminal.write("w"));
    await app.terminal.waitText("Evicting the oldest is right for this load.");
    await app.terminal.waitIdle();
    const weighed = requestsTo(app, REVIEWER).at(-1)?.prompt ?? "";
    assert.match(
      weighed,
      /The operator's question: Weigh in on this reply from Main[^\n]*\n> Use an LRU cache keyed by path\.\n> Evict the oldest entry first\./,
    );
  } finally {
    await app.close();
  }
});

test("reviewers stand side by side where each has 60 columns and stacked where not; only the cursor's esc or /consult cancel stops them", async () => {
  const app = await launchPi({
    cols: 160,
    rows: 45,
    apiModels: [MAIN, REVIEWER, SECOND],
    env: { PITUITARY_CONSULT_MODELS: `openai/${REVIEWER.id},openai/${SECOND.id}` },
  });
  const first = held("Bound the cache before it grows.");
  const second = held("Shard the cache by directory.");
  try {
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    app.provider.replyTo(REVIEWER.id, first.reply);
    app.provider.replyTo(SECOND.id, second.reply);
    await consult(app, () => app.terminal.submit("/consult"));
    await app.terminal.waitText("Bound the cache before it grows.");
    await app.terminal.waitText("Shard the cache by directory.");
    await app.terminal.waitIdle();
    const beside = await app.capture("consult-beside");
    assert.match(beside, /╭─ ◆ Reviewer · [^\n]*╭─ ◆ Second · /);
    assert.match(beside, /◆ 2 models weighing in/);

    // Plain esc, pressed again and again, leaves them answering.
    for (let press = 0; press < 3; press++) await app.terminal.keyboard.press("Escape");
    await app.terminal.waitIdle();
    await app.terminal.resize(100, 28);
    await waitMatch(app.terminal, /╭─ ◆ Reviewer · [^\n]*\n[\s\S]*╭─ ◆ Second · /);
    await app.terminal.waitIdle();
    const stacked = await app.capture("consult-stacked");
    assert.match(stacked, /╭─ ◆ Reviewer · [^\n]*\n[\s\S]*╭─ ◆ Second · /);
    assert.doesNotMatch(stacked, /╭─ ◆ Reviewer · [^\n]*╭─ ◆ Second/);

    // On a card, the cursor's esc cancels that one alone, and leaves: esc again cancels nothing.
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("esc cancel");
    await app.capture("consult-card-cursor");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /╭─ ◆ Second/);
    await app.terminal.waitText("◆ Reviewer weighing in");
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitIdle();
    assert.match(await app.capture("consult-one-cancelled"), /╭─ ◆ Reviewer · /);
    await app.terminal.submit("/consult cancel");
    await waitGone(app.terminal, /╭─ ◆ Reviewer/);
    await app.terminal.waitText("cancelled 1 second opinion");
    assert.doesNotMatch(await app.capture("consult-cancelled"), /weighing in|weighs in/);
  } finally {
    first.release();
    second.release();
    await app.close();
  }
});

test("a reviewer whose Pi cannot start says why on its card, in Pi's words, until dismissed", async () => {
  const app = await launchPi({ apiModels: [MAIN], env: { PITUITARY_CONSULT_MODELS: "missing/reviewer" } });
  try {
    // An empty conversation has nothing to consult on, so no list opens.
    await app.terminal.submit("/consult");
    await app.terminal.waitText("There is nothing to consult on yet: ask something first.");
    assert.doesNotMatch(await app.terminal.text(), /second opinion · space marks several/);
    await turn(app, "plan the cache", "Use an LRU cache keyed by path.");
    await app.terminal.submit("/consult");
    await app.terminal.waitText("declared · Pi does not list it");
    await app.terminal.waitIdle();
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText('Unknown provider "missing"');
    await app.terminal.waitIdle();
    const failed = await app.capture("consult-failed");
    assert.match(failed, /╭─ ◆ missing\/reviewer · failed/);
    assert.match(failed, /Pi exited \(1\)/);
    await app.terminal.write(CTRL_F);
    await app.terminal.waitText("esc dismiss");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /Unknown provider/);
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
    again = await launchPi({ from: app, apiModels: [MAIN, REVIEWER], argv: ["--session", file as string] });
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
