import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { pastGrace, press, RUNNING, waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const DOWN = "\x1b[B";
const CTRL_R = "\x12";
const CTRL_C = "\x03";

/**
 * An extension with a status every session shows, a command that takes Pituitary's bridge's
 * name, so Pi renames both, and a handler that throws on request.
 */
const DEMO = `
export default function (pi) {
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("demo", "demo ready"));
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
    await app.terminal.waitText("Ask pi something to get started.");
    await app.terminal.waitIdle();
    // The new session's extensions set their statuses before Pi answers /new; they stay.
    const fresh = await app.capture("sessions-new");
    assert.match(fresh, /demo ready/);
    assert.doesNotMatch(fresh, /first question/);
    await ask(app, "second question");

    await app.terminal.submit("/resume");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitIdle();
    const listed = await app.capture("sessions-resume");
    assert.match(listed, /▸ second question +just now · \d+ messages/);
    assert.match(listed, / {2}first question +just now · \d+ messages/);
    assert.match(listed, /ctrl\+r rename · ctrl\+x delete/);

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
    await app.terminal.waitIdle();
    const resumed = await app.capture("sessions-resumed");
    assert.doesNotMatch(resumed, /second question/);
    assert.match(resumed, /Planning/);
    assert.match(resumed, /demo ready/);
    // Pi renamed both `pituitary` commands; the bridge was found by its file, and no request reached the model.
    assert.doesNotMatch(resumed, /the other pituitary ran/);
    assert.deepEqual(
      app.provider.requests.map((request) => request.prompt),
      ["first question", "second question"],
    );
    await app.terminal.write("\x04");
    await app.terminal.waitText("Resume: pituitary --session");

    // `pituitary --resume` looks for this project's sessions at start, in place of Pi's own picker;
    // from another project, /resume all finds them, and Pi moves to the project they began in.
    again = await launchPi({ from: app, argv: ["--resume"], project: "other" });
    await again.terminal.waitText(
      "This project has no saved sessions yet. /resume all lists every project's.",
    );
    await again.terminal.submit("/resume all");
    await again.terminal.waitText("resume · every project's sessions");
    await again.terminal.waitIdle();
    const everywhere = await again.capture("sessions-resume-all");
    assert.match(everywhere, /Planning +just now · \d+ messages · ~\/sample/);
    await again.terminal.type("second");
    await again.terminal.waitText("1 of 2");
    await again.terminal.keyboard.press("Enter");
    await again.terminal.waitText("Reply to: second question");
    await again.terminal.waitText("Working in ~/sample, where this session started");
    await again.terminal.waitIdle();
    const moved = await again.capture("sessions-resumed-elsewhere");
    assert.match(moved, /^ ~\/sample /m);
  } finally {
    await app.close();
    await again?.close();
    await app.provider.close();
  }
});

test("a fork starts from an earlier prompt in the draft; a clone copies the session; an export says where", async () => {
  const app = await launchPi();
  try {
    await ask(app, "alpha");
    await ask(app, "beta");
    assert.equal(app.sessions().length, 1);
    await app.terminal.submit("/fork");
    await app.terminal.waitText("fork · a new session from before an earlier prompt");
    await app.terminal.waitIdle();
    const picker = await app.capture("sessions-fork-picker");
    assert.match(picker, /▸ beta +latest prompt · \d\d:\d\d/);
    assert.match(picker, /alpha +1 prompt ago/);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Forked into a new session · editing your earlier prompt");
    await waitMatch(app.terminal, /» beta/);
    await app.terminal.waitIdle();
    const forked = await app.capture("sessions-forked");
    assert.match(forked, /Reply to: alpha/);
    assert.doesNotMatch(forked, /Reply to: beta/);
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

    await app.terminal.submit("/export");
    await app.terminal.waitText("Exported this session to ~/sample/");
    await app.terminal.waitIdle();
    await app.capture("sessions-exported");
    assert.equal(readdirSync(app.cwd).filter((name) => name.endsWith(".html")).length, 1);
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
    await ask(app, "first question");
    await app.terminal.submit("/session");
    await app.terminal.waitText("/session copy copies its path");
    await app.terminal.submit("/settings");
    await app.terminal.waitText("Press enter to run /settings");
    await app.capture("sessions-handoff-pi");
    // Pi's editor holds the command, so ctrl+c twice is the way back.
    await app.terminal.write(CTRL_C);
    await app.terminal.write(CTRL_C);
    await app.terminal.waitText("Reply to: first question");
    await app.terminal.waitText("/session copy copies its path");
    await app.terminal.waitIdle();
    await app.capture("sessions-handoff-back");
    await ask(app, "after the handoff");
    // Pi came back on the same session, so the model still sees the first exchange.
    assert.match(JSON.stringify(app.provider.requests.at(-1)?.body.input), /first question/);
  } finally {
    await app.close();
    await app.provider.close();
  }
});
