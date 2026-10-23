import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { type LaunchOptions, launch, settled } from "./helpers/harness.ts";

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
}
