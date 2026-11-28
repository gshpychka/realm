import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { pastGrace, press, RUNNING, waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const CTRL_R = "\x12";
const CTRL_X = "\x18";
const CTRL_C = "\x03";
const ALT_F = "\x1bf";

/**
 * An extension with a status every session shows, a notice for a new session and a failure for
 * a resumed one as they start, a command that takes Pituitary's bridge's name, so Pi renames
 * both, and a handler that throws on request.
 */
const DEMO = `
export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    ctx.ui.setStatus("demo", "demo ready");
    if (event.reason === "new") ctx.ui.notify("demo noticed a new session", "warning");
    if (event.reason === "resume") throw new Error("demo cannot start here");
  });
  pi.on("before_agent_start", (event) => {
    if (event.prompt?.includes("explode")) throw new Error("demo handler exploded");
  });
  pi.registerCommand("pituitary", {
    description: "takes the bridge's name",
    handler: async (_args, ctx) => ctx.ui.notify("the other pituitary ran", "warning"),
  });
}
`;

/** Sends `text` and waits for the provider's reply to it. */
async function ask(app: Awaited<ReturnType<typeof launchPi>>, text: string) {
  await app.terminal.submit(text);
  await app.terminal.waitText(`Reply to: ${text}`);
  await app.terminal.waitIdle();
}

test("sessions are started afresh, listed, renamed and resumed without leaving the screen", async () => {
  const app = await launchPi({ extensions: { "demo.ts": DEMO } });
  let again: Awaited<ReturnType<typeof launchPi>> | undefined;
  try {
    await app.terminal.waitText("demo ready");
    await ask(app, "first question");
    await app.terminal.submit("/new");
    await app.terminal.waitText("demo noticed a new session");
    await app.terminal.waitIdle();
    // The new session's extensions set statuses and notify before Pi answers /new, starting
    // twice over; the statuses stay and the notice shows once, in the new session.
    const fresh = await app.capture("sessions-new");
    assert.match(fresh, /demo ready/);
    assert.equal(fresh.match(/demo noticed a new session/g)?.length, 1);
    assert.doesNotMatch(fresh, /first question/);
    await ask(app, "second question");

    await app.terminal.submit("/resume");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitIdle();
    const listed = await app.capture("sessions-resume");
    assert.match(listed, /▸ second question +just now · 1 prompt +│/);
    assert.match(listed, / {2}first question +just now · 1 prompt +│/);
    assert.match(listed, /ctrl\+r rename · ctrl\+x delete · tab every project/);
    // As in Pi's own list, tab switches between this project's sessions and every project's.
    await app.terminal.write("\t");
    await app.terminal.waitText("resume · every project's sessions");
    await app.terminal.waitText("tab this project");
    await app.terminal.write("\t");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitText("▸ second question");

    // The session Pi has open is renamed through Pi, another in its own file.
    await app.terminal.write(CTRL_R);
    await app.terminal.waitText("Rename “second question”");
    await pastGrace();
    await app.terminal.type("Ongoing");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("▸ Ongoing");
    await press(app.terminal, DOWN, "▸ first question");
    await app.terminal.write(CTRL_R);
    await app.terminal.waitText("Rename “first question”");
    await pastGrace();
    await app.terminal.type("Planning");
    await app.terminal.waitText("Planning");
    await app.capture("sessions-rename-dialog");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("▸ Planning");
    await app.terminal.waitIdle();
    await app.capture("sessions-renamed");
    // The picker's frame closes at the new right edge once it has drawn at the new size.
    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /this project's sessions {20,}│/);
    await app.capture("sessions-resume-80");
    await app.terminal.resize(100, 28);
    await waitMatch(app.terminal, /this project's sessions {40,}│/);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reply to: first question");
    await app.terminal.waitText("demo cannot start here");
    await app.terminal.waitIdle();
    const resumed = await app.capture("sessions-resumed");
    assert.doesNotMatch(resumed, /second question/);
    assert.match(resumed, /Planning/);
    assert.match(resumed, /demo ready/);
    // An extension failing as the resumed session starts shows in that session, once.
    assert.equal(resumed.match(/demo\.ts · session_start: demo cannot start here/g)?.length, 1);
    // Pi renamed both `pituitary` commands; the bridge was found by its file, and no request reached the model.
    assert.doesNotMatch(resumed, /the other pituitary ran/);
    assert.deepEqual(
      app.provider.requests.map((request) => request.prompt),
      ["first question", "second question"],
    );
    await app.terminal.write("\x04");
    await app.terminal.waitText("Resume: pituitary --session");

    // A prompt template of the project the sessions began in, which Pi loads once it moves there.
    mkdirSync(join(app.cwd, ".pi", "prompts"), { recursive: true });
    writeFileSync(
      join(app.cwd, ".pi", "prompts", "only-here.md"),
      "---\ndescription: a prompt of the sample project\n---\nhello from sample\n",
    );
    // `pituitary --resume` in a project without sessions lists every project's at once, in place
    // of Pi's own picker, and Pi moves to the project the chosen session began in.
    again = await launchPi({ from: app, argv: ["--resume", "--approve"], project: "other" });
    await again.terminal.waitText("resume · every project's sessions · none in this project yet");
    await again.terminal.waitIdle();
    const everywhere = await again.capture("sessions-resume-all");
    assert.match(everywhere, /Planning +just now · 1 prompt · ~\/sample +│/);
    // The filter finds a renamed session by its first prompt too.
    await again.terminal.type("second");
    await again.terminal.waitText("1 of 2");
    await again.terminal.waitText("▸ Ongoing");
    await again.terminal.keyboard.press("Enter");
    await again.terminal.waitText("Reply to: second question");
    await again.terminal.waitText("Working in ~/sample, where this session started");
    await again.terminal.waitIdle();
    const moved = await again.capture("sessions-resumed-elsewhere");
    assert.match(moved, /^ ~\/sample /m);
    // Pi's commands follow the session to its project.
    await again.terminal.type("/only-here");
    await again.terminal.waitText("a prompt of the sample project");
    await again.capture("sessions-moved-commands");
    await again.terminal.keyboard.press("Enter");
    await again.terminal.waitText("Reply to: hello from sample");
    await again.terminal.waitIdle();
    // Pi writes an export where its process started, and the notice says so.
    await again.terminal.submit("/export");
    await again.terminal.waitText("Exported this session to");
    await again.terminal.waitIdle();
    const exported = await again.capture("sessions-exported-elsewhere");
    assert.match(exported, /~\/other\/pi-session-\S+\.html/);
    assert.equal(readdirSync(again.cwd).filter((name) => name.endsWith(".html")).length, 1);
  } finally {
    await app.close();
    await again?.close();
    await app.provider.close();
  }
});

test("a fork puts an earlier prompt in place of the draft; a clone copies the session; one is deleted; an export says where", async () => {
  const app = await launchPi();
  try {
    await ask(app, "alpha");
    await ask(app, "beta");
    assert.equal(app.sessions().length, 1);
    await app.terminal.type("half written draft");
    await app.terminal.waitText("half written draft");
    await app.terminal.write(ALT_F);
    await app.terminal.waitText("fork · a new session from before an earlier prompt");
    await app.terminal.waitIdle();
    const picker = await app.capture("sessions-fork-picker");
    assert.match(picker, /▸ beta +latest prompt · \d\d:\d\d/);
    assert.match(picker, /alpha +1 prompt ago/);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText(
      "Forked into a new session · editing your earlier prompt · esc u brings your draft back",
    );
    await waitMatch(app.terminal, /» beta/);
    await app.terminal.waitIdle();
    const forked = await app.capture("sessions-forked");
    assert.match(forked, /Reply to: alpha/);
    assert.doesNotMatch(forked, /Reply to: beta|half written draft/);
    assert.equal(app.sessions().length, 2);

    // The draft goes to the new session, which answers it.
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reply to: beta");
    await app.terminal.waitIdle();
    await app.terminal.submit("/clone");
    await app.terminal.waitText("Cloned this session into a new one");
    await app.terminal.waitIdle();
    const cloned = await app.capture("sessions-cloned");
    assert.match(cloned, /Reply to: alpha[\s\S]*Reply to: beta[\s\S]*Cloned this session/);
    assert.equal(app.sessions().length, 3);

    // The session Pi has open stays; another one goes once confirmed, and the list comes back.
    await app.terminal.submit("/resume");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.write(CTRL_X);
    await app.terminal.waitText("Pi has this session open, so it stays");
    await press(app.terminal, UP, "▸ alpha");
    await app.terminal.write(CTRL_X);
    await app.terminal.waitText("Delete “alpha”? · just now · 2 prompts");
    await app.terminal.waitIdle();
    await app.capture("sessions-delete-dialog");
    await press(app.terminal, DOWN, "▶ Delete it");
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /deleted the session|moved the session to the trash/);
    await app.terminal.waitText("2 of 2");
    await app.terminal.waitIdle();
    await app.capture("sessions-deleted");
    assert.equal(app.sessions().length, 2);
    await app.terminal.keyboard.press("Escape");

    await app.terminal.submit("/export");
    await app.terminal.waitText("Exported this session to");
    await app.terminal.waitIdle();
    const exported = await app.capture("sessions-exported");
    assert.match(exported, /^ +~\/sample\/pi-session-\S+\.html$/m);
    assert.equal(readdirSync(app.cwd).filter((name) => name.endsWith(".html")).length, 1);
    await app.terminal.submit("/export notes/out.html");
    await app.terminal.waitText("/export: the folder notes/ does not exist");

    // A reload loads again what Pi offers, such as a prompt template added since it started.
    mkdirSync(join(app.agent, "prompts"), { recursive: true });
    writeFileSync(
      join(app.agent, "prompts", "added-later.md"),
      "---\ndescription: added after start\n---\nhi\n",
    );
    await app.terminal.submit("/reload");
    await app.terminal.waitText("Reloaded Pi's extensions");
    await app.terminal.type("/added");
    await app.terminal.waitText("added after start");
    await app.terminal.waitIdle();
    await app.capture("sessions-reloaded");
    assert.equal(app.provider.requests.length, 3);
  } finally {
    await app.close();
    await app.provider.close();
  }
});

test("a new session while Pi works takes the queued messages back into the draft and stops the run", async () => {
  const app = await launchPi();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    app.provider.reply({ text: "never shown", until: held });
    await app.terminal.submit("a long task");
    await waitMatch(app.terminal, RUNNING);
    await app.terminal.submit("and a note for later");
    await waitMatch(app.terminal, /^ +.*and a note for later/m);
    await app.capture("sessions-queued-before-new");
    // As Pi's own /reload, a reload waits for the run rather than pulling the extensions from under it.
    await app.terminal.submit("/reload");
    await app.terminal.waitText("Wait for the current response to finish before reloading.");
    await app.terminal.submit("/new");
    await app.terminal.waitText("Ask pi something to get started.");
    await waitMatch(app.terminal, /» and a note for later/);
    await app.terminal.waitIdle();
    const fresh = await app.capture("sessions-new-while-running");
    assert.doesNotMatch(fresh, /a long task|never shown/);
    assert.doesNotMatch(fresh, RUNNING);
    assert.deepEqual(
      app.provider.requests.map((request) => request.prompt),
      ["a long task"],
    );
  } finally {
    release();
    await app.close();
    await app.provider.close();
  }
});

test("without Pituitary's bridge Pi is asked nothing, and extension failures are shown", async () => {
  const app = await launchPi({ withoutBridge: true, extensions: { "demo.ts": DEMO } });
  try {
    await app.terminal.submit("/resume");
    await app.terminal.waitText("nothing was sent");
    await app.terminal.submit("/reload");
    await waitMatch(app.terminal, /\/reload: Pi has not loaded/);
    await app.terminal.waitIdle();
    await app.capture("sessions-no-bridge");
    assert.equal(app.provider.requests.length, 0);
    await ask(app, "explode now");
    const failed = await app.capture("sessions-extension-error");
    assert.match(failed, /demo\.ts · before_agent_start: demo handler exploded/);
  } finally {
    await app.close();
    await app.provider.close();
  }
});

test("Pi's own screens take the terminal and give it back with the conversation as it was", async () => {
  const app = await launchPi();
  try {
    // Pi writes the session's file with its first message.
    await app.terminal.submit("/session");
    await app.terminal.waitText("file not saved until the first message");
    await ask(app, "first question");
    await app.terminal.submit("/session");
    await app.terminal.waitText("/session copy copies it");
    await app.terminal.submit("/settings");
    await app.terminal.waitText("Press enter to run /settings");
    await app.capture("sessions-handoff-pi");
    // Pi's editor holds the command, so ctrl+c twice is the way back.
    await app.terminal.write(CTRL_C);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("Reply to: first question");
    await app.terminal.waitText("/session copy copies it");
    await app.terminal.waitIdle();
    await app.capture("sessions-handoff-back");
    await ask(app, "after the handoff");
    // Pi came back on the same session, so the model still sees the first exchange.
    assert.match(JSON.stringify(app.provider.requests.at(-1)?.body.input), /first question/);
    // The screen is cleared once Pi's own closes, so Pi's exit line is not left beside Pituitary's.
    await app.terminal.write("\x04");
    const closed = await waitMatch(app.terminal, /Resume: pituitary --session/);
    assert.doesNotMatch(closed, /To resume this session|Press enter to run/);
  } finally {
    await app.close();
    await app.provider.close();
  }
});
