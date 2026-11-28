import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { cellsOf, pastGrace, press, RUNNING, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";
import { killPi, launchPi, MODEL, MODEL_NAME, type PiLaunch } from "./helpers/pi.ts";

after(async () => {
  await closeAll();
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const CTRL_R = "\x12";
const CTRL_E = "\x05";
const CTRL_D = "\x04";
const CTRL_C = "\x03";
const CTRL_O = "\x0f";
const SHIFT_TAB = "\x1b[Z";
const ALT_F = "\x1bf";

/**
 * An extension with a status every session shows, a status and a widget only the session Pi
 * starts with shows, a notice for a new session and a failure for a resumed one as they start, a
 * command that takes Pituitary's bridge's name, so Pi renames both, a handler that throws on
 * request, a message for the model alone, a command that fails, and one that shows a message.
 */
const DEMO = `
export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    ctx.ui.setStatus("demo", "demo ready");
    if (event.reason === "startup") {
      ctx.ui.setStatus("boot", "booted");
      ctx.ui.setWidget("boot", ["startup widget"]);
    }
    if (event.reason === "new") ctx.ui.notify("demo noticed a new session", "warning");
    if (event.reason === "resume") throw new Error("demo cannot start here");
  });
  pi.on("before_agent_start", (event) => {
    if (event.prompt?.includes("explode")) throw new Error("demo handler exploded");
    if (event.prompt?.includes("remember"))
      return { message: { customType: "memory", content: "hidden-memory-marker", display: false } };
  });
  pi.registerCommand("pituitary", {
    description: "takes the bridge's name",
    handler: async (_args, ctx) => ctx.ui.notify("the other pituitary ran", "warning"),
  });
  pi.registerCommand("plan", {
    description: "fails",
    handler: async () => {
      throw new Error("no plan yet");
    },
  });
  pi.registerCommand("note", {
    description: "shows a note",
    handler: async () => pi.sendMessage({ customType: "note", content: "shown-note-marker", display: true }),
  });
}
`;

/** An extension that says so each time a session starts. */
const STARTED = `
export default function (pi) {
  pi.on("session_start", (_event, ctx) => ctx.ui.notify("demo started", "info"));
}
`;

/** Sends `text` and waits for the provider's reply to it. */
async function ask(app: PiLaunch, text: string) {
  await app.terminal.submit(text);
  await app.terminal.waitText(`Reply to: ${text}`);
  await app.terminal.waitIdle();
}

/** The entries of a session file Pi wrote. */
function entriesOf(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The text of a message entry, as Pi stores it. */
function said(entry: Record<string, unknown>): string {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? (content as { text?: string }[]) : [])
    .map((part) => part.text ?? "")
    .join("");
}

/** The saved session whose first prompt is `prompt`: its id and its file, which Pi names. */
function savedSession(app: PiLaunch, prompt: string): { id: string; file: string } {
  for (const file of app.sessions()) {
    const [header, ...entries] = entriesOf(file);
    const first = entries.find((entry) => (entry.message as { role?: string } | undefined)?.role === "user");
    if (first && said(first) === prompt) return { id: String(header?.id), file };
  }
  throw new Error(`no saved session starts with ${prompt}`);
}

/**
 * Writes a session beside `from`, as Pi would: its header and settings with a new id, then one
 * exchange that opens with `prompt`, made `hoursAgo` before `from`'s.
 */
function seedSession(from: string, prompt: string, hoursAgo: number): void {
  const [header, ...entries] = entriesOf(from);
  const settings = entries.filter(
    (entry) => entry.type === "model_change" || entry.type === "thinking_level_change",
  );
  const user = entries.find((entry) => (entry.message as { role?: string } | undefined)?.role === "user");
  const reply = entries.find(
    (entry) => (entry.message as { role?: string } | undefined)?.role === "assistant",
  );
  const id = randomUUID();
  const message = (
    entry: Record<string, unknown> | undefined,
    entryId: string,
    parentId: unknown,
    text: string,
  ) => {
    const said = entry?.message as { timestamp: number };
    const at = said.timestamp - hoursAgo * 3_600_000;
    return {
      ...entry,
      id: entryId,
      parentId,
      timestamp: new Date(at).toISOString(),
      message: { ...said, timestamp: at, content: [{ type: "text", text }] },
    };
  };
  const lines = [
    { ...header, id },
    ...settings,
    message(user, "seeded01", settings.at(-1)?.id ?? null, prompt),
    message(reply, "seeded02", "seeded01", "Reply to: the seeded session"),
  ];
  const file = join(dirname(from), `seeded_${id}.jsonl`);
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("sessions are started afresh, listed, renamed and resumed without leaving the screen", async () => {
  // The project's name holds a space, which a shell reads as two words.
  const app = await launchPi({ extensions: { "demo.ts": DEMO }, project: "my project" });
  let again: PiLaunch | undefined;
  try {
    await app.terminal.waitText("demo ready");
    await app.terminal.waitText("booted");
    await app.terminal.waitText("startup widget");
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
    // What only the first session showed went with it.
    assert.doesNotMatch(fresh, /booted|startup widget/);
    await ask(app, "second question");

    await app.terminal.submit("/resume");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitIdle();
    const listed = await app.capture("sessions-resume");
    // The session Pi has open says so, and the details line up at the right edge.
    assert.match(listed, /▶ second question · current +just now · 1 prompt +│/);
    assert.match(listed, / {2}first question +just now · 1 prompt +│/);
    assert.match(listed, /ctrl\+r rename · ctrl\+x delete · tab every project/);
    // The bridge answers out of band, so nothing of its replies shows.
    assert.doesNotMatch(listed, /"ok":|"sessions":|pituitary-\d+/);
    // As in Pi's own list, tab switches between this project's sessions and every project's.
    await app.terminal.write("\t");
    await app.terminal.waitText("resume · every project's sessions");
    await app.terminal.waitText("tab this project");
    await app.terminal.write("\t");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitText("▶ second question");

    // The session Pi has open is renamed through Pi, another in its own file.
    await app.terminal.write(CTRL_R);
    await app.terminal.waitText("Rename “second question”");
    await pastGrace();
    await app.terminal.type("Ongoing");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("▶ Ongoing");
    await press(app.terminal, DOWN, "▶ first question");
    await app.terminal.write(CTRL_R);
    await app.terminal.waitText("Rename “first question”");
    await pastGrace();
    await app.terminal.type("Planning");
    await app.terminal.waitText("Planning");
    await app.capture("sessions-rename-dialog");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("▶ Planning");
    await app.terminal.waitIdle();
    await app.capture("sessions-renamed");
    // The picker's frame closes at the new right edge once it has drawn at the new size.
    await app.terminal.resize(80, 24);
    await waitMatch(app.terminal, /this project's sessions {20,}│/);
    // A narrow hint keeps the list's own keys, the way out and the count, before moving and picking.
    await waitMatch(
      app.terminal,
      /^│ ctrl\+r rename · ctrl\+x delete · tab every project · esc close · 2 of 2 +│$/m,
    );
    await app.capture("sessions-resume-80");
    // Narrower still, the hint leaves out whole keys and keeps the count.
    const title = "resume · this project's sessions";
    await app.terminal.resize(58, 24);
    await waitMatch(app.terminal, re.m`^│ ${title}${" ".repeat(58 - 3 - title.length)}│$`);
    await waitMatch(app.terminal, /^│ .* · 2 of 2 +│$/m);
    const narrow = await app.capture("sessions-resume-58");
    const hint = /^│ (.*) · 2 of 2 +│$/m.exec(narrow)?.[1] ?? "";
    const keys = [
      "↑↓ move",
      "enter pick",
      "ctrl+r rename",
      "ctrl+x delete",
      "tab every project",
      "esc close",
    ];
    assert.ok(hint.length > 0 && hint.split(" · ").every((key) => keys.includes(key)), narrow);
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
    // The exit line names the whole session, which Pi resumes by its id.
    const planning = savedSession(app, "first question");
    await app.terminal.write(CTRL_D);
    await app.terminal.waitText(`Resume: pituitary --session ${planning.id}`);

    // A prompt template of the project the sessions began in, which Pi loads once it moves there.
    mkdirSync(join(app.cwd, ".pi", "prompts"), { recursive: true });
    writeFileSync(
      join(app.cwd, ".pi", "prompts", "only-here.md"),
      "---\ndescription: a prompt of the first project\n---\nhello from the first project\n",
    );
    // A session last at work three hours ago, whose first prompt carries a terminal control and
    // runs past a list row.
    seedSession(
      planning.file,
      "he\x1b[31mllo and a much longer first prompt that runs on past the width of a row in the list of sessions, so the row cuts it",
      3,
    );
    // `pituitary --resume` in a project without sessions lists every project's at once, in place
    // of Pi's own picker, and Pi moves to the project the chosen session began in.
    again = await launchPi({ from: app, argv: ["--resume", "--approve"], project: "other" });
    await again.terminal.waitText("resume · every project's sessions · none in this project yet");
    await again.terminal.waitIdle();
    const everywhere = await again.capture("sessions-resume-all");
    assert.match(everywhere, /Planning +just now · 1 prompt · ~\/my project +│/);
    // The terminal control is never drawn, and the long prompt is cut at its end, its details,
    // which say how long ago it was at work, whole at the right edge.
    const seeded = everywhere.split("\n").find((row) => row.includes("hello")) ?? "";
    assert.match(
      seeded,
      /^│ {3}hello and a much longer first prompt .*\S… +3h ago · 1 prompt · ~\/my project │$/,
    );
    // What follows the control is drawn as every other row is, in no colour of its own.
    const [plan] = await cellsOf(again.terminal, "Planning");
    for (const cell of await cellsOf(again.terminal, "llo and a much")) {
      assert.deepEqual(cell.fg, plan?.fg);
      assert.deepEqual(cell.bg, plan?.bg);
    }
    // The filter finds a renamed session by its first prompt too.
    await again.terminal.type("second");
    await again.terminal.waitText("1 of 3");
    await again.terminal.waitText("▶ Ongoing");
    await again.terminal.keyboard.press("Enter");
    await again.terminal.waitText("Reply to: second question");
    await again.terminal.waitText("Working in ~/my project, where this session started");
    await again.terminal.waitIdle();
    const moved = await again.capture("sessions-resumed-elsewhere");
    assert.match(moved, /^ ~\/my project /m);
    // Pi's commands follow the session to its project.
    await again.terminal.type("/only-here");
    await again.terminal.waitText("a prompt of the first project");
    await again.capture("sessions-moved-commands");
    await again.terminal.keyboard.press("Enter");
    await again.terminal.waitText("Reply to: hello from the first project");
    await again.terminal.waitIdle();
    // Pi writes an export where its process started, and the notice says so.
    await again.terminal.submit("/export");
    await again.terminal.waitText("Exported this session to");
    await again.terminal.waitIdle();
    const exported = await again.capture("sessions-exported-elsewhere");
    assert.match(exported, /~\/other\/pi-session-\S+\.html/);
    assert.equal(readdirSync(again.cwd).filter((name) => name.endsWith(".html")).length, 1);

    // Once Pi is gone, the draft stays and the status says how to come back to the session, from
    // the project it moved to, whole rather than cut.
    const ongoing = savedSession(app, "second question");
    const asked = app.provider.requests.length;
    killPi(again);
    await again.terminal.waitText("Conversation disconnected: Pi exited");
    await again.terminal.submit("still there?");
    await again.terminal.waitText("Disconnected · run");
    await again.terminal.waitIdle();
    const lost = await again.capture("sessions-disconnected");
    assert.doesNotMatch(lost, /…/);
    assert.match(lost, /» still there\?/);
    assert.equal(app.provider.requests.length, asked);
    // So does the exit line, once the draft is cleared, on one row of a wide terminal.
    await again.terminal.write(CTRL_C);
    await waitMatch(again.terminal, /» ask pi/);
    await again.terminal.resize(200, 28);
    await again.terminal.write(CTRL_D);
    const exit = await waitMatch(again.terminal, re.m`^Resume: (.+ --session ${ongoing.id})$`);
    const pasted = re.m`^Resume: (.+ --session ${ongoing.id})$`.exec(exit)?.[1] ?? "";
    // The status said the same, wrapped where it must, so its words are compared without the breaks.
    const unwrapped = (text: string) => text.replace(/\s+/g, "");
    assert.ok(unwrapped(lost).includes(unwrapped(`Disconnected · run ${pasted}`)), lost);
    // Pasted into a shell, the command starts Pituitary in the project the session moved to, on
    // that session.
    const ran = spawnSync("sh", ["-c", `pituitary() { pwd; printf '%s\\n' "$@"; }; ${pasted}`], {
      cwd: again.cwd,
      encoding: "utf8",
    });
    assert.deepEqual(ran.stdout.trim().split("\n"), [app.cwd, "--session", ongoing.id], ran.stderr);
  } finally {
    // The relaunch closes first: closing the launch it came from removes their HOME.
    await again?.close();
    await app.close();
  }
});

test("a fork puts an earlier prompt in place of the draft; a clone copies the session; one is deleted; an export says where", async () => {
  // A `trash` command that moves what it is given into a folder of its own.
  const scratch = mkdtempSync("/tmp/pituitary-trash-");
  const can = join(scratch, "can");
  mkdirSync(can);
  mkdirSync(join(scratch, "bin"));
  writeFileSync(join(scratch, "bin", "trash"), `#!/bin/sh\n[ "$1" = "--" ] && shift\nexec mv "$1" ${can}/\n`);
  chmodSync(join(scratch, "bin", "trash"), 0o755);
  const app = await launchPi({
    env: { PATH: `${join(scratch, "bin")}:${process.env.PATH}` },
    // Pituitary's own bindings rename with ctrl+e, and Pi's delete from its list with ctrl+d.
    keybindings: { "app.session.rename": "ctrl+e" },
    piKeybindings: { "app.session.delete": "ctrl+d" },
  });
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
    assert.match(picker, /▶ beta +latest prompt · \d\d:\d\d/);
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
    // The fork's notice belonged to the session the clone replaced.
    assert.doesNotMatch(cloned, /Forked into a new session/);
    assert.equal(app.sessions().length, 3);

    // Pi records where a fork and a clone came from, and the list draws each under its source.
    await app.terminal.submit("/resume");
    await app.terminal.waitText("resume · this project's sessions");
    await app.terminal.waitIdle();
    const forks = await app.capture("sessions-forks");
    assert.match(forks, /^│ {3}alpha +just now · 2 prompts +│$/m);
    assert.match(forks, /^│ {3}└ alpha +just now · 2 prompts +│$/m);
    assert.match(forks, /^│ ▶ {3}└ alpha · current +just now · 2 prompts +│$/m);
    // The list's keys follow the bindings: Pituitary's own, and Pi's where Pi's list has the action.
    assert.match(forks, /ctrl\+e rename · ctrl\+d delete · tab every project/);
    await app.terminal.write(CTRL_R);
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.terminal.text(), /Rename “/);
    await app.terminal.write(CTRL_E);
    await app.terminal.waitText("Rename “alpha”");
    await pastGrace();
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("resume · this project's sessions");
    await waitMatch(app.terminal, /▶ {3}└ alpha · current/);

    // The session Pi has open stays; another one goes once confirmed, and the list comes back.
    await app.terminal.write(CTRL_D);
    await app.terminal.waitText("Pi has this session open, so it stays");
    await press(app.terminal, UP, "▶ alpha");
    await app.terminal.write(CTRL_D);
    await app.terminal.waitText("Delete “alpha”? · just now · 2 prompts");
    await app.terminal.waitIdle();
    await app.capture("sessions-delete-dialog");
    await press(app.terminal, DOWN, "▶ Delete it");
    await app.terminal.keyboard.press("Enter");
    // The notice says where the session went: here a trash command took it.
    await app.terminal.waitText("moved the session to the trash");
    await app.terminal.waitText("2 of 2");
    await app.terminal.waitIdle();
    const deleted = await app.capture("sessions-deleted");
    assert.equal(app.sessions().length, 2);
    assert.equal(readdirSync(can).filter((name) => name.endsWith(".jsonl")).length, 1);
    // The fork whose source went moves to the top, its clone still under it.
    assert.match(deleted, /^│ {3}alpha +just now · 2 prompts +│$/m);
    assert.match(deleted, /^│ ▶ └ alpha · current +just now · 2 prompts +│$/m);
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
    // Outside the list, ctrl+d still quits.
    await app.terminal.write(CTRL_C);
    await waitMatch(app.terminal, /» ask pi/);
    await app.terminal.write(CTRL_D);
    await app.terminal.waitText("Resume: pituitary --session");
  } finally {
    await app.close();
    rmSync(scratch, { recursive: true, force: true });
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

    // Pi lost before the new session's first prompt has written nothing to resume, so the status
    // says to start Pituitary again rather than naming a session, and the draft stays.
    killPi(app);
    await app.terminal.waitText("Conversation disconnected: Pi exited");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Disconnected · restart pituitary");
    await app.terminal.waitIdle();
    const lost = await app.capture("sessions-disconnected-unsaved");
    assert.doesNotMatch(lost, /--session/);
    assert.match(lost, /» and a note for later/);
  } finally {
    release();
    await app.close();
  }
});

test("without Pituitary's bridge Pi is asked nothing; extension failures show, and what an extension gives the model alone does not", async () => {
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
    // Its detail names the extension by its whole path.
    await app.terminal.write(CTRL_O);
    await waitMatch(app.terminal, re.m`^ +${join(app.home, "extensions", "demo.ts")}$`);
    await app.terminal.write(CTRL_O);
    // An extension's command that fails says so, and asks the model nothing.
    await app.terminal.submit("/plan");
    await app.terminal.waitText("/plan: no plan yet");
    assert.equal(app.provider.requests.length, 1);

    // A message an extension adds for the model alone reaches it and stays off the screen, even
    // with every box open; one it shows, shows.
    app.provider.reply("Noted.");
    await app.terminal.submit("remember this");
    await app.terminal.waitText("Noted.");
    await app.terminal.waitIdle();
    assert.match(JSON.stringify(app.provider.requests.at(-1)?.body), /hidden-memory-marker/);
    await app.terminal.submit("/note");
    await app.terminal.waitText("shown-note-marker");
    await app.terminal.write(CTRL_O);
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.capture("sessions-extension-messages"), /hidden-memory-marker/);
    // Reading the session again keeps it so.
    await app.terminal.write(SHIFT_TAB);
    await app.terminal.waitText("thinking: ");
    await app.terminal.waitIdle();
    const reread = await app.terminal.text();
    assert.match(reread, /shown-note-marker/);
    assert.doesNotMatch(reread, /hidden-memory-marker/);
    // An extension's failure is kept too.
    assert.match(reread, /demo\.ts · before_agent_start: demo handler exploded/);
  } finally {
    await app.close();
  }
});

test("Pi's own screens take the terminal and give it back with the conversation as it was, or the session Pi ends on", async () => {
  const app = await launchPi({ extensions: { "started.ts": STARTED } });
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

    // A session started after Pi's own screen runs on the model the operator chose, as the first did.
    await app.terminal.submit("/new");
    await waitMatch(app.terminal, /^(?![\s\S]*first question)/);
    await ask(app, "second question");
    assert.match((await app.terminal.text()).split("\n").at(-1) ?? "", re`${MODEL_NAME}`);
    assert.equal(app.provider.requests.at(-1)?.body.model, MODEL);

    // Pi's own screen can move to another session, and the conversation comes back on that one.
    await app.terminal.submit("/settings");
    await app.terminal.waitText("Press enter to run /settings");
    await app.terminal.write(CTRL_C);
    await app.terminal.type("/resume");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Resume Session");
    await app.terminal.type("first question");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Reply to: after the handoff");
    await app.capture("sessions-handoff-pi-resumed");
    await app.terminal.write(CTRL_C);
    await app.terminal.write(CTRL_C);
    await waitMatch(app.terminal, /^ ● Reply to: after the handoff/m);
    await app.terminal.waitIdle();
    const elsewhere = await app.capture("sessions-handoff-elsewhere");
    assert.doesNotMatch(elsewhere, /second question/);
    assert.equal(elsewhere.match(/demo started/g)?.length, 1);
    await ask(app, "back on the first");
    const body = JSON.stringify(app.provider.requests.at(-1)?.body.input);
    assert.match(body, /first question/);
    assert.doesNotMatch(body, /second question/);

    // The screen is cleared once Pi's own closes, so Pi's exit line is not left beside Pituitary's.
    await app.terminal.write("\x04");
    const closed = await waitMatch(app.terminal, /Resume: pituitary --session/);
    assert.doesNotMatch(closed, /To resume this session|Press enter to run/);
  } finally {
    await app.close();
  }
});
