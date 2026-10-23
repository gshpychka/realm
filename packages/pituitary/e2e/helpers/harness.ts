import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TuiTest } from "@microsoft/tui-test";
import { survivors } from "./processes.ts";

export { survivors };

export const REPO = join(import.meta.dirname, "..", "..");
const TUI_ENTRY = join(REPO, "packages/tui/src/app.fixture.tsx");
const FAKE_GH = join(REPO, "e2e/fixtures/gh");
const SCREENS = join(REPO, "artifacts", "screens");

/** The UI's working directory, relative to the throwaway HOME. */
export const PROJECT = join("projects", "work", "sample");
/** The branch the working directory's repository has checked out unless a test names another. */
export const BRANCH = "main";
/** Files the working directory holds, for mentioning with `@`. */
const PROJECT_FILES = {
  "README.md": "# sample\n",
  "src/main.ts": "export {};\n",
  "src/footer.tsx": "export {};\n",
  "docs/guide.md": "# guide\n",
} satisfies Record<string, string>;

/**
 * Where each run's throwaway HOME goes. The bridge's socket sits three levels inside it, and a
 * socket path holds at most 104 bytes on macOS, whose TMPDIR alone runs to about 50.
 */
const SCRATCH = process.platform === "darwin" ? "/tmp" : tmpdir();

/**
 * What describes the terminal the tests are run from, which OpenTUI reads to judge what its
 * terminal can draw. The UI runs in tui-test's terminal, which TERM and COLORTERM describe.
 */
export const OPERATOR_TERMINAL = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_FEATURES",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "WT_SESSION",
  "VTE_VERSION",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "KITTY_WINDOW_ID",
  "KITTY_PID",
  "ITERM_SESSION_ID",
  "WEZTERM_PANE",
  "GHOSTTY_RESOURCES_DIR",
  "GHOSTTY_BIN_DIR",
  "GHOSTTY_SHELL_FEATURES",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
];

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * `command` under script(1), which copies every byte it writes to the terminal into `file` as
 * it goes. util-linux script takes the command as one shell string; BSD script, as on macOS,
 * takes it as arguments.
 */
function recorded(command: string[], file: string): string[] {
  return process.platform === "linux"
    ? ["script", "-qfec", `exec ${command.map(quote).join(" ")}`, file]
    : ["script", "-qF", file, ...command];
}

/** The UI process running with `home` as its HOME. */
export function uiPid(home: string): number {
  const ui = survivors(home).find(
    (line) =>
      (line.includes("packages/tui/src/main.tsx") || line.includes("packages/tui/src/app.fixture.tsx")) &&
      !line.includes(" script "),
  );
  if (!ui) throw new Error(`no UI process runs with HOME=${home}`);
  return Number(ui.split(" ")[0]);
}

/** Waits out a new dialog's grace period, in which it ignores the keyboard. */
export const pastGrace = () => new Promise((resolve) => setTimeout(resolve, 450));

/**
 * Writes `key` until `text` shows. A component draws before its keyboard handler is live,
 * so a key sent the moment a picker appears can land before the picker hears it.
 */
export async function press(terminal: TuiTest, key: string, text: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    await terminal.write(key);
    const deadline = Date.now() + 250;
    while (Date.now() < deadline) {
      if ((await terminal.text()).includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(`"${text}" never showed after writing ${JSON.stringify(key)}`);
  }
}

/** Presses and releases the left mouse button over the cell at `col`, `row`, both counted from 0. */
export async function click(terminal: TuiTest, col: number, row: number): Promise<void> {
  // SGR mouse reports count cells from 1.
  const at = (end: string) => `\x1b[<0;${col + 1};${row + 1}${end}`;
  await terminal.write(at("M") + at("m"));
}

/** Turns the mouse wheel `notches` over the cell at `col`, `row`: down when positive, up when negative. */
export async function wheel(terminal: TuiTest, col: number, row: number, notches: number): Promise<void> {
  // SGR mouse reports count cells from 1; buttons 64 and 65 are the wheel turning up and down.
  const turn = `\x1b[<${notches < 0 ? 64 : 65};${col + 1};${row + 1}M`;
  await terminal.write(turn.repeat(Math.abs(notches)));
}

/** Drags the left mouse button along `row` from column `from` to `to`, all counted from 0. */
export async function drag(terminal: TuiTest, row: number, from: number, to: number): Promise<void> {
  // SGR mouse reports count cells from 1: press, drag, release.
  const at = (button: number, col: number, end = "M") => `\x1b[<${button};${col + 1};${row + 1}${end}`;
  await terminal.write(at(0, from) + at(32, from + 1) + at(32, to) + at(0, to, "m"));
}

/** Resolves once the screen matches `pattern`. */
export async function waitMatch(terminal: TuiTest, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const screen = await terminal.text();
    if (pattern.test(screen)) return screen;
    if (Date.now() - start > timeoutMs) throw new Error(`screen never matched ${pattern}:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The status line of a run in progress, whatever the run is doing. */
export const RUNNING = / · \d+s( · |\s*$)/m;

/** Resolves once no run's status line shows. */
export async function settled(terminal: TuiTest, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const screen = await terminal.text();
    if (!RUNNING.test(screen)) return screen;
    if (Date.now() - start > timeoutMs) throw new Error(`the run never settled:\n${screen}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The draft's row while nvim is in normal mode, its `N` tag first. */
export const NORMAL = /^ N( |$)/m;

/**
 * Presses escape and waits for normal mode. The draft starts in insert mode, where the
 * first escape leaves it; a second escape then reaches the app.
 */
export async function normalMode(terminal: TuiTest): Promise<void> {
  await terminal.keyboard.press("Escape");
  await waitMatch(terminal, NORMAL);
}

export const COLS = 100;
export const ROWS = 28;

export interface BootOptions {
  /** A bun entry point that draws a full-screen UI. */
  entry: string;
  /** Arguments for the entry point. */
  argv?: string[];
  /** The entry point's working directory. */
  cwd?: string;
  /** Text on the first frame, which marks the UI as up. */
  ready: string;
  env?: Record<string, string>;
  /** Run through a separate tmux server; env.TERM describes the outer test terminal. */
  tmux?: boolean;
  cols?: number;
  rows?: number;
  /**
   * Waits for output to stop before handing over. A screen that animates never
   * stops, so it boots with `settle: false`.
   */
  settle?: boolean;
  /** A file that receives every byte the entry point writes to the terminal, through `script`. */
  record?: string;
}

export interface Harness {
  terminal: TuiTest;
  /**
   * Writes the current screen to artifacts/screens as text, SVG, and PNG, and returns
   * the text. The PNG carries colour, which the text drops.
   */
  capture(name: string): Promise<string>;
  /** Captures `frames` screens `everyMs` apart as `<name>-<n>`, for judging motion. */
  film(name: string, frames: number, everyMs: number): Promise<string[]>;
  close(): Promise<void>;
}

/** Runs `entry` under bun in a headless PTY. */
export async function boot(options: BootOptions): Promise<Harness> {
  const {
    entry,
    argv = [],
    cwd = REPO,
    ready,
    env = {},
    tmux: throughTmux = false,
    cols = COLS,
    rows = ROWS,
    settle = true,
    record,
  } = options;
  const terminal = TuiTest.ephemeral("tui", { timeouts: { text: 15_000, idle: 15_000, ready: 30_000 } });
  const multiplex = throughTmux ? isolatedTmux() : undefined;
  const command = [
    "env",
    ...OPERATOR_TERMINAL.flatMap((name) => ["-u", name]),
    ...(multiplex?.command ?? []),
    "bun",
    entry,
    ...argv,
  ];
  const [program = "env", ...args] = record ? recorded(command, record) : command;
  try {
    await terminal.run(program, args, {
      cols,
      rows,
      cwd,
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        SHELL: "/bin/sh",
        ...env,
      },
    });
    await terminal.waitText(ready);
    if (settle) await terminal.waitIdle();
  } catch (error) {
    await terminal.closeQuiet();
    multiplex?.close();
    throw error;
  }

  const capture = async (name: string) => {
    const screen = await terminal.text();
    mkdirSync(SCREENS, { recursive: true });
    writeFileSync(join(SCREENS, `${name}.txt`), `${screen}\n`);
    const svg = join(SCREENS, `${name}.svg`);
    await terminal.screenshot(svg);
    rasterise(svg);
    return screen;
  };

  return {
    terminal,
    capture,
    film: async (name, frames, everyMs) => {
      const screens: string[] = [];
      for (let frame = 0; frame < frames; frame++) {
        if (frame > 0) await new Promise((resolve) => setTimeout(resolve, everyMs));
        screens.push(await capture(`${name}-${frame}`));
      }
      return screens;
    },
    close: async () => {
      try {
        await terminal.closeQuiet();
      } finally {
        multiplex?.close();
      }
    },
  };
}

/** A separate server using Realm's terminal settings, never the operator's tmux server. */
function isolatedTmux() {
  const scratch = mkdtempSync(join(SCRATCH, "pituitary-tmux-"));
  const socket = join(scratch, "socket");
  const config = join(scratch, "tmux.conf");
  writeFileSync(
    config,
    `source-file ${quote(join(REPO, "../../modules/home-manager/tmux/tmux.conf"))}\n` +
      'set -g default-terminal "tmux-256color"\nset -g status off\n',
  );
  return {
    command: ["tmux", "-S", socket, "-f", config, "new-session", "-s", "ui"],
    close() {
      spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

export interface LaunchOptions {
  /** Native Faux provider fixture: hello, long, tool, thinking, or sprawl. */
  scenario?: string;
  /** Milliseconds between scripted events, for observing intermediate states. */
  delayMs?: number;
  cols?: number;
  rows?: number;
  /** Extra environment for the UI process. */
  env?: Record<string, string>;
  /** Run through a separate tmux server; env.TERM describes the outer test terminal. */
  tmux?: boolean;
  /** Arguments for the UI itself, as `pituitary` would be given them. */
  argv?: string[];
  /**
   * The branch checked out in the UI's working directory, a fresh repository at `PROJECT`;
   * false leaves the directory outside any repository.
   */
  branch?: string | false;
  /**
   * Runs before the UI starts, given the throwaway HOME, the session directory inside it,
   * and the UI's working directory.
   */
  prepare?(home: string, sessions: string, cwd: string): void | Promise<void>;
  /** False returns as soon as the first frame shows, before the screen goes idle. */
  settle?: boolean;
  /** Records every byte the UI writes to the terminal, for `raw()`. */
  record?: boolean;
}

export interface Mark {
  /** Milliseconds since the UI process started. */
  at: number;
  /** The wall clock, in milliseconds since the epoch. */
  epoch: number;
}

export interface Launched extends Harness {
  /** The throwaway HOME; its `run` directory is the UI's XDG_RUNTIME_DIR. */
  home: string;
  /** The UI's working directory, `PROJECT` inside the throwaway HOME. */
  cwd: string;
  /** The UI's timing marks, as PITUITARY_PROFILE writes them. */
  profile(): Record<string, Mark>;
  /** Everything the UI wrote to the terminal, when launched with `record`. */
  raw(): string;
}

/**
 * Runs the UI against an actual native Harness and upstream Faux model.
 *
 * HOME, the session directory, and the working directory point into a throwaway tree, so
 * a run reads and writes none of the operator's pi state and sees none of the checkout it
 * runs from.
 */
export async function launch(options: LaunchOptions = {}): Promise<Launched> {
  const {
    scenario = "hello",
    delayMs = 0,
    cols = COLS,
    rows = ROWS,
    env = {},
    tmux,
    prepare,
    argv = [],
    settle = true,
    record = false,
    branch = BRANCH,
  } = options;
  // The UI and pi see their working directory with symlinks resolved.
  const home = realpathSync(mkdtempSync(join(SCRATCH, "pituitary-e2e-")));
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(home, "run"), { mode: 0o700 });
  const cwd = project(home, branch);
  await prepare?.(home, sessions, cwd);
  const profile = join(home, "profile");
  const raw = join(home, "terminal.raw");

  const harness = await boot({
    entry: TUI_ENTRY,
    argv,
    cwd,
    // The footer draws the working directory on the first frame, so it marks the app as
    // up regardless of how long the machine takes to start bun under parallel test load.
    ready: basename(PROJECT),
    tmux,
    cols,
    rows,
    settle,
    record: record ? raw : undefined,
    env: {
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      XDG_CONFIG_HOME: join(home, ".config"),
      PITUITARY_PROFILE: profile,
      // Ambient fires hold one frame, so a screen settles; a test of their motion turns this off.
      PITUITARY_STILL: "1",
      // The footer asks gh for the branch's pull request; a test never reaches GitHub.
      PITUITARY_GH: FAKE_GH,
      FAKE_GH_STATE: "none",
      FAKE_GH_LOG: join(home, "gh.log"),
      PITUITARY_LOG: join(home, "tui.log"),
      PITUITARY_FIXTURE_SCENARIO: scenario,
      PITUITARY_FIXTURE_DELAY: String(delayMs),
      ...env,
    },
  });
  return {
    ...harness,
    home,
    cwd,
    profile: () => readProfile(profile),
    raw: () => readFileSync(raw, "latin1"),
  };
}

/** Writes the working directory under `home`: a repository on `branch`, or a plain directory. */
function project(home: string, branch: string | false): string {
  const cwd = join(home, PROJECT);
  for (const [path, text] of Object.entries(PROJECT_FILES)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  if (branch === false) return cwd;
  const git = spawnSync("git", ["init", "--quiet", `--initial-branch=${branch}`], {
    cwd,
    encoding: "utf8",
    // The operator's git configuration stays out, so every run starts from the same repository.
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr || git.error}`);
  return cwd;
}

function readProfile(path: string): Record<string, Mark> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .map(([name = "", at = "", epoch = ""]) => [name, { at: Number(at), epoch: Number(epoch) }]),
  );
}

/**
 * Renders an SVG capture to a PNG beside it.
 *
 * resvg loads no system fonts in the dev shell, so the fonts come from the paths it
 * exports; outside the shell there is nothing to render with and the PNG is skipped.
 */
function rasterise(svg: string): void {
  const fonts = process.env.PITUITARY_FONT_DIR;
  if (!fonts) return;
  const extra = [process.env.PITUITARY_FALLBACK_FONT_DIR, process.env.PITUITARY_SYMBOL_FONT_DIR].filter(
    Boolean,
  );
  spawnSync("resvg", [
    "--skip-system-fonts",
    "--use-fonts-dir",
    fonts,
    ...extra.flatMap((dir) => ["--use-fonts-dir", dir as string]),
    "--font-family",
    "JetBrains Mono",
    svg,
    svg.replace(/\.svg$/, ".png"),
  ]);
}
