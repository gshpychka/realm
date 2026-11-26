import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import {
  boot,
  drag,
  type Launched,
  type LaunchOptions,
  launch,
  settled,
  waitMatch,
} from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";

/** Complete synchronized frames, as seen by the outer terminal rather than a tmux pane. */
function synchronized(raw: string, streaming = false): number {
  let open = false;
  let frames = 0;
  let previous = 0;
  const outside = (text: string) => {
    if (!streaming) return;
    // Mode negotiation, cursor placement and metadata may occur between frames.
    // Painting characters or erasing cells must be protected by a complete frame.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
    const controls = text.replace(/\x1b[\]P_][\s\S]*?(?:\x07|\x1b\\)/g, "");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
    assert.doesNotMatch(controls, /\x1b\[[0-?]*[ -/]*[JKLMPX@]/, "unprotected cell erasure");
    const visible = controls
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
      .replace(/[\x00-\x20\x7f]/g, "");
    assert.equal(visible, "", "redraw text escaped synchronized output");
  };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: DEC synchronized-output markers
  for (const match of raw.matchAll(/\x1b\[\?2026[hl]/g)) {
    const marker = match[0];
    if (!open) outside(raw.slice(previous, match.index));
    if (marker === BEGIN) {
      assert.equal(open, false, "a redraw started before the previous frame ended");
      open = true;
    } else if (marker === END) {
      // Terminal setup and teardown may explicitly reset the mode without starting a frame.
      if (open) frames++;
      open = false;
    }
    previous = match.index + marker.length;
  }
  if (!open) outside(raw.slice(previous));
  assert.equal(open, false, "the terminal was left holding an unfinished redraw");
  return frames;
}

test("balanced frames cannot hide an unsynchronized redraw", () => {
  assert.equal(synchronized(`${BEGIN}protected${END}`, true), 1);
  assert.throws(() => synchronized(`${BEGIN}protected${END}escaped`, true), /redraw text/);
  assert.throws(() => synchronized(`${BEGIN}protected${END}\x1b[2J`, true), /cell erasure/);
});

// Model Ghostty directly and as tmux's outer terminal, using a PTY rather than a GUI emulator.
const ghostty = {
  TERM: "xterm-ghostty",
  TERMINFO_DIRS: [process.env.PITUITARY_GHOSTTY_TERMINFO, process.env.TERMINFO_DIRS ?? ""]
    .filter((path) => path !== undefined)
    .join(":"),
};
const TERMINALS: { name: string; options: LaunchOptions }[] = [
  { name: "ghostty", options: { env: ghostty } },
  { name: "tmux-ghostty", options: { tmux: true, env: ghostty } },
];

for (const { name, options } of TERMINALS) {
  test(`${name} forwards the login clipboard protocol`, async (t) => {
    const scratch = mkdtempSync("/tmp/pituitary-clipboard-");
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const raw = join(scratch, "terminal.raw");
    const app = await boot({
      ...options,
      entry: join(import.meta.dirname, "fixtures/clipboard.ts"),
      ready: "clipboard ready",
      record: raw,
    });
    try {
      await app.terminal.write("\x18");
      await app.terminal.waitText("copied");
      await app.terminal.waitIdle();
      const encoded = Buffer.from("https://example.test/sign-in").toString("base64");
      assert.ok(
        readFileSync(raw, "latin1").includes(`\x1b]52;c;${encoded}`),
        "login clipboard write never reached the outer terminal",
      );
    } finally {
      await app.close();
    }
  });

  test(`${name} forwards selected text to the outer clipboard`, async () => {
    const app = await launch({ ...options, record: true });
    try {
      const text = "https://example.test/sign-in";
      await app.terminal.type(text);
      await app.terminal.waitText(`» ${text}`);
      const row = (await app.terminal.text()).split("\n").findIndex((line) => line.startsWith(" » "));
      await drag(app.terminal, row, 3, 3 + text.length);
      await app.terminal.waitText("copied");
      await app.terminal.waitIdle();
      const encoded = Buffer.from(text).toString("base64");
      assert.ok(
        app.raw().includes(`\x1b]52;c;${encoded}`),
        "clipboard write never reached the outer terminal",
      );
    } finally {
      await app.close();
    }
  });

  test(`${name} receives complete synchronized redraws while a reply streams`, async () => {
    const app = await launch({ ...options, scenario: "long", delayMs: 30, record: true });
    try {
      await app.terminal.waitIdle();
      const before = app.raw().length;
      await app.terminal.submit("write a lot");
      await app.terminal.waitText("line 40 of the long answer");
      await settled(app.terminal);
      await app.terminal.waitText("ask pi");
      await app.terminal.waitIdle();
      const screen = await app.capture(`terminal-${name}`);
      assert.match(screen, /line 40 of the long answer/);
      assert.match(screen, /ask pi/);
      assert.ok(synchronized(app.raw().slice(before), true) > 1, `${name} did not protect streaming redraws`);
      await app.terminal.write("\x04");
      await app.terminal.waitExit();
      synchronized(app.raw());
    } finally {
      await app.close();
    }
  });

  test(`${name} pastes text and images through the kitty clipboard protocol`, async () => {
    const app = await launch({ ...options, record: true });
    try {
      // The PTY's emulator answers the mode query with no such mode, so the test answers as
      // Ghostty does. tmux keeps the first answer, so its configuration declares the mode instead.
      if (!options.tmux) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
        await output(app, /\x1b\[\?5522\$p/);
        await app.terminal.write("\x1b[?5522;2$y");
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
      await output(app, /\x1b\[\?5522h/);

      await paste(app, "text/plain", "text/plain", base64("look at "));
      await app.terminal.waitText("» look at");
      await paste(app, "text/plain image/png", "image/png", PIXEL);
      await app.terminal.waitText("image 1");
      await app.terminal.type(" please");
      // The chip's end is a glyph of its own between its label and the next word.
      await waitMatch(app.terminal, /look at .{1,4}image 1. please/u);
      await app.capture(`image-draft-${name}`);

      await app.terminal.submit();
      // The scenario echoes the prompt it received, image included.
      await app.terminal.waitText('"type":"image"');
      await settled(app.terminal);
      const screen = await app.capture(`image-sent-${name}`);
      assert.match(screen, /▌ look at .{1,4}image 1. please/u, "the sent message lost its image chip");
    } finally {
      await app.close();
    }
  });
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const osc = (body: string) => `\x1b]5522;${body}\x1b\\`;
/** A one-pixel PNG. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURY7AfN6Y4QkAAAAKSURBVAjXY2AAAAACAAHiIbwzAAAAAElFTkSuQmCC";

/**
 * Pastes as Ghostty does with paste events on: announces a clipboard of `types`, then answers
 * the read it is asked for, which must carry the paste's password and ask for `mime`.
 */
async function paste(app: Launched, types: string, mime: string, data: string): Promise<void> {
  const from = app.raw().length;
  await app.terminal.write(
    osc(`type=read:status=OK:pw=${base64("once")}`) +
      osc(`type=read:status=DATA:mime=${base64(".")};${base64(types)}`) +
      osc("type=read:status=DONE"),
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
  const [, meta = "", asked] = await output(app, /\x1b\]5522;type=read:([^\x1b;]*);([^\x1b]*)\x1b\\/, from);
  assert.match(meta, new RegExp(`pw=${base64("once")}`), "the read lost the paste's password");
  assert.equal(asked, base64(mime));
  const id = /id=([^:]+)/.exec(meta)?.[1];
  await app.terminal.write(
    osc(`type=read:status=OK:id=${id}`) +
      osc(`type=read:status=DATA:mime=${base64(mime)}:id=${id};${data}`) +
      osc(`type=read:status=DONE:id=${id}`),
  );
}

/** The first match of `pattern` in what the UI has written to the terminal from offset `from` on. */
async function output(app: Launched, pattern: RegExp, from = 0, timeoutMs = 5000): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(app.raw().slice(from));
    if (match) return match;
    if (Date.now() > deadline) throw new Error(`the terminal never received ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
