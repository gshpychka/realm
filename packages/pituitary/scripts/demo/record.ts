// Records the showcase: each scene is pituitary driven the way a person would, captured by
// asciinema as a cast, rendered to a GIF by agg, with PNG stills of the moments worth keeping.
//
//   node scripts/demo/record.ts            every scene
//   node scripts/demo/record.ts work vim   only those
//
// Runs inside the dev shell, which provides nvim, resvg, and the fonts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, TuiTest } from "@microsoft/tui-test";
import { glyphs } from "../../packages/tui/src/glyphs.ts";

const REPO = join(import.meta.dirname, "..", "..");
const OUT = process.env.DEMO_OUT ?? join(REPO, "artifacts", "demo");
const TUI = join(REPO, "packages/tui/src/main.tsx");
const AGENT = join(REPO, "scripts/demo/agent.ts");
const EXTENSION = join(REPO, "scripts/demo/extension.ts");
const PI = join(REPO, "node_modules/.bin/pi");
const EMBER = join(REPO, "packages/ember/showcase/main.tsx");
const FAKE_GH = join(REPO, "e2e/fixtures/gh");

/** gruvbox dark, as agg reads a theme: background, foreground, then the 16 palette colours. */
const THEME = [
  "282828",
  "ebdbb2",
  "282828",
  "cc241d",
  "98971a",
  "d79921",
  "458588",
  "b16286",
  "689d6a",
  "a89984",
  "928374",
  "fb4934",
  "b8bb26",
  "fabd2f",
  "83a598",
  "d3869b",
  "8ec07c",
  "ebdbb2",
].join(",");

function nixBin(attr: string, bin: string): string {
  const built = spawnSync("nix", ["build", "--no-link", "--print-out-paths", `nixpkgs#${attr}`], {
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`nix build nixpkgs#${attr} failed: ${built.stderr}`);
  return join(built.stdout.trim().split("\n").at(-1) ?? "", "bin", bin);
}

function nixPath(attr: string): string {
  const built = spawnSync("nix", ["build", "--no-link", "--print-out-paths", `nixpkgs#${attr}`], {
    encoding: "utf8",
  });
  if (built.status !== 0) throw new Error(`nix build nixpkgs#${attr} failed: ${built.stderr}`);
  return built.stdout.trim().split("\n").at(-1) ?? "";
}

const ASCIINEMA = nixBin("asciinema", "asciinema");
const AGG = nixBin("asciinema-agg", "agg");
const FFMPEG = nixBin("ffmpeg.bin", "ffmpeg");
const NERD_FONT_DIR = join(
  nixPath("nerd-fonts.jetbrains-mono"),
  "share/fonts/truetype/NerdFonts/JetBrainsMono",
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A throwaway HOME holding a small project, so the screens show nothing of the operator's. */
function workspace(): { home: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "pituitary-demo-"));
  const home = join(root, "home");
  const project = join(home, "code", "ledger");
  for (const dir of [
    join(home, ".pi", "agent"),
    join(home, "sessions"),
    join(home, "run"),
    join(project, "src"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, ".pi", "agent", "settings.json"), "{}");
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "ledger", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(project, "src", "retry.ts"), "export const DEFAULT_WINDOW_HOURS = 24;\n");
  const git = (...args: string[]) =>
    spawnSync(
      "git",
      [
        "-c",
        "user.name=demo",
        "-c",
        "user.email=demo@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: project,
        env: { ...process.env, HOME: home },
      },
    );
  git("init", "-q", "-b", "feat/retry-window");
  git("add", ".");
  git("commit", "-q", "-m", "Start the ledger");
  return { home, project };
}

interface Driver {
  terminal: TuiTest;
  /** Types like a person: a character at a time, at an uneven pace. */
  type(text: string): Promise<void>;
  key(sequence: string, pauseMs?: number): Promise<void>;
  pause(ms: number): Promise<void>;
  wait(text: string, timeoutMs?: number): Promise<void>;
  still(name: string): Promise<void>;
  /** Names this moment of the recording, for a loop to begin or end near. */
  mark(name: string): void;
}

interface Scene {
  name: string;
  cols?: number;
  rows?: number;
  /** A scripted session and its pace, or arguments for the real pi. */
  agent?: { scenario: string; delayMs?: number } | { pi: string[] };
  /** A bun entry point other than pituitary. */
  entry?: { path: string; env: Record<string, string> };
  /** Text on the first fully drawn frame, where the GIF starts; pituitary's footer shows the context use once pi answers. */
  ready: string;
  play(driver: Driver): Promise<void>;
  /** How the program is asked to quit. */
  quit?: string;
  /**
   * A scene of continuous motion plays as a seamless loop, cut where the last frame
   * matches the first: its first frame falls between the marks `from` names and its last
   * between the marks `to` names, or any window of `LOOP_MIN_S` to `LOOP_MAX_S` without them.
   * A narrative scene holds its final frame, then starts over.
   */
  loop?: { from?: [string, string]; to?: [string, string] };
  /** Frames per second, higher where motion is quick. */
  fps?: number;
}

const CTRL_D = "\x04";
const CTRL_O = "\x0f";
const CTRL_T = "\x14";
const CTRL_J = "\n";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const ENTER = "\r";

const scenes: Scene[] = [
  {
    name: "work",
    agent: { scenario: "demo-work", delayMs: 24 },
    ready: "ctx 0%",
    async play(d) {
      await d.pause(900);
      await d.type("cap the retry window at a week, and prove it with a test");
      await d.pause(500);
      await d.key(ENTER);
      await d.wait("still retries for a day", 30_000);
      await d.pause(1800);
      await d.still("work-done");
      await d.key(CTRL_O, 2600);
      await d.still("work-expanded");
      await d.key(CTRL_O, 900);
      await d.key(CTRL_T, 2200);
    },
  },
  {
    name: "vim",
    agent: { scenario: "demo-work" },
    ready: "ctx 0%",
    async play(d) {
      await d.pause(800);
      await d.type('rename "retryWindow" to "backoff" in the payout worker');
      await d.pause(700);
      await d.key(ESC, 900);
      await d.type('0f"');
      await d.pause(500);
      await d.type('ci"');
      await d.pause(300);
      await d.type("windowHours");
      await d.key(ESC, 800);
      await d.type("w");
      await d.pause(400);
      await d.type("dw");
      await d.pause(900);
      await d.type("u");
      await d.pause(900);
      await d.type("0ve");
      await d.pause(1200);
      await d.still("vim-visual");
      await d.key(ESC, 500);
      await d.type("A");
      await d.pause(300);
      await d.key(CTRL_J, 250);
      await d.type("- keep the default at one day");
      await d.key(CTRL_J, 250);
      await d.type("- cover the cap with a test");
      await d.pause(600);
      await d.key(ESC, 900);
      await d.still("vim-grown");
      await d.key(ENTER, 2500);
    },
  },
  {
    name: "palette",
    agent: { scenario: "demo-work" },
    ready: "ctx 0%",
    async play(d) {
      await d.pause(800);
      await d.type("/");
      await d.pause(1400);
      await d.still("palette");
      await d.type("mo");
      await d.pause(900);
      await d.key(ENTER);
      await d.wait("2 of 2");
      await d.pause(1100);
      await d.key(DOWN, 700);
      await d.key(ENTER);
      await d.wait("fake-model-2");
      await d.pause(1200);
      await d.type("/thin");
      await d.pause(700);
      await d.key(ENTER);
      await d.wait("thinking level");
      await d.pause(900);
      await d.key(DOWN, 600);
      await d.key(ENTER, 1800);
    },
  },
  {
    name: "extension",
    agent: { pi: ["--no-session", "--no-extensions", "-e", EXTENSION] },
    // Real pi reports no context use in a session without a reply; the card shows once its stats arrive.
    ready: glyphs.card,
    async play(d) {
      await d.pause(900);
      await d.type("/release");
      await d.pause(600);
      await d.key(ENTER);
      await d.wait("minor");
      await d.pause(1200);
      await d.still("extension-component");
      await d.key(DOWN, 700);
      await d.key(ENTER);
      await d.wait("Publish to which channel?");
      await d.pause(1000);
      await d.key(DOWN, 600);
      await d.key(ENTER);
      await d.wait("Tag the release?");
      await d.pause(1100);
      await d.key(ENTER);
      await d.wait("Release note");
      await d.pause(700);
      await d.type("caps the payout retry window at a week");
      await d.pause(400);
      await d.key(ENTER);
      await d.wait("tagged v1.4.0");
      await d.pause(2600);
    },
  },
  {
    name: "shell",
    agent: { scenario: "demo-work", delayMs: 40 },
    ready: "ctx 0%",
    async play(d) {
      await d.pause(800);
      await d.type("!bun test src/retry.test.ts");
      await d.pause(400);
      await d.key(ENTER);
      await d.wait("Ran 6 tests", 15_000);
      await d.pause(1400);
      await d.type("!!git status --short");
      await d.pause(400);
      await d.key(ENTER);
      await d.wait("not in context");
      await d.pause(1200);
      await d.still("shell");
      await d.pause(1200);
    },
  },
  {
    name: "limits",
    agent: { scenario: "demo-limits", delayMs: 30 },
    ready: "ctx 0%",
    async play(d) {
      await d.pause(800);
      await d.type("how close am I to my limits?");
      await d.pause(400);
      await d.key(ENTER);
      await d.wait("weekly", 15_000);
      await d.pause(1800);
      await d.still("limits-footer");
      await d.type("/usage");
      await d.pause(500);
      await d.key(ENTER);
      await d.wait("Spend in dollars");
      await d.pause(3200);
      await d.still("limits-usage");
    },
  },
  {
    name: "narrow",
    cols: 60,
    rows: 24,
    agent: { scenario: "demo-limits", delayMs: 30 },
    ready: "ctx 0%",
    async play(d) {
      await d.pause(700);
      await d.type("how close am I to my limits?");
      await d.key(ENTER);
      await d.wait("weekly", 15_000);
      await d.pause(2200);
      await d.still("narrow");
    },
  },
  {
    // One round trip of the fire: it smoulders in the corner, glides up to the working line
    // and flares while pi works, then dies down and glides home. The loop is the second of two
    // identical rounds, which ends on the screen it began on.
    name: "mascot",
    agent: { scenario: "demo-mascot", delayMs: 45 },
    // The footer reports one round's context use throughout, from the first frame.
    ready: "ctx 12%",
    fps: 40,
    loop: { from: ["home", "asking"], to: ["home again", "end"] },
    async play(d) {
      const round = async () => {
        await d.type("where is the retry window set?");
        await d.pause(300);
        await d.key(ENTER);
        await until(d, (screen) => screen.includes("interrupts"));
        await until(d, (screen) => !screen.includes("interrupts"), { steadyMs: 500, timeoutMs: 20_000 });
        // The fire eases down and glides home once the run settles.
        await d.pause(1400);
      };
      await d.pause(600);
      await round();
      d.mark("home");
      await d.pause(1200);
      d.mark("asking");
      await round();
      d.mark("home again");
      await d.pause(1200);
      d.mark("end");
    },
  },
  {
    name: "embers",
    entry: { path: EMBER, env: { EMBER_VIEW: "flames" } },
    ready: "ember",
    quit: "\x03",
    loop: {},
    async play(d) {
      // Long enough to hold a loop window whose ends match.
      await d.pause(16000);
      await d.still("embers");
    },
  },
];

/**
 * Waits until the screen has satisfied `done` for `steadyMs`. The fire draws over text as it
 * travels, so a read taken mid-glide can miss text that is there.
 */
async function until(
  d: Driver,
  done: (screen: string) => boolean,
  { steadyMs = 0, timeoutMs = 10_000 }: { steadyMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  let since: number | null = null;
  for (;;) {
    const now = Date.now();
    if (done(await d.terminal.text())) {
      since ??= now;
      if (now - since >= steadyMs) return;
    } else since = null;
    if (now - start > timeoutMs) throw new Error("the screen never reached the awaited state");
    await sleep(15);
  }
}

async function record(scene: Scene): Promise<void> {
  const { home, project } = workspace();
  const cols = scene.cols ?? 100;
  const rows = scene.rows ?? 28;
  const cast = join(OUT, `${scene.name}.cast`);
  const agent = scene.agent;
  // The operator's own profile file stays out, so the demo writes no timing marks into it.
  const { PITUITARY_PROFILE: _profile, ...inherited } = process.env as Record<string, string>;
  const env: Record<string, string> = {
    ...inherited,
    HOME: home,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: join(home, "run"),
    PITUITARY_LOG: join(home, "tui.log"),
    PITUITARY_STILL: "0",
    // The demo branch has an open pull request, answered by the scripted gh.
    PITUITARY_GH: FAKE_GH,
    FAKE_GH_STATE: "open",
    FAKE_GH_NUMBER: "1234",
    PI_CODING_AGENT_SESSION_DIR: join(home, "sessions"),
    ...(agent && "pi" in agent
      ? { PI_AGENT_CMD: PI, PI_AGENT_ARGS: agent.pi.join(" ") }
      : {
          PI_AGENT_CMD: "bun",
          PI_AGENT_ARGS: AGENT,
          FAKE_PI_SCENARIO: agent?.scenario ?? "demo-work",
          FAKE_PI_DELAY_MS: String(agent?.delayMs ?? 0),
        }),
    ...(scene.entry?.env ?? {}),
  };
  const program = `bun ${scene.entry?.path ?? TUI}`;

  const terminal = TuiTest.ephemeral(`demo-${scene.name}`, {
    timeouts: { text: 20_000, idle: 20_000, ready: 30_000 },
  });
  await terminal.run(
    ASCIINEMA,
    ["rec", "--quiet", "--overwrite", "-f", "asciicast-v2", "-i", "1.5", "-c", program, cast],
    {
      cols,
      rows,
      cwd: project,
      env,
    },
  );
  await terminal.waitText(scene.ready);
  // The cast starts on the frame that showed `ready`, so marks count from here.
  const readyAt = performance.now();
  const marks = new Map<string, number>();

  // Keys a person types arrive unevenly; a fixed seed keeps each recording the same.
  let seed = 7;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const driver: Driver = {
    terminal,
    mark(name) {
      marks.set(name, (performance.now() - readyAt) / 1000);
    },
    async type(text) {
      for (const char of text) {
        await terminal.write(char);
        await sleep(38 + jitter() * 70 + (char === " " ? 30 : 0));
      }
    },
    async key(sequence, pauseMs = 0) {
      await terminal.write(sequence);
      await sleep(pauseMs || 120);
    },
    pause: sleep,
    async wait(text, timeoutMs = 20_000) {
      const start = Date.now();
      while (!(await terminal.text()).includes(text)) {
        if (Date.now() - start > timeoutMs)
          throw new Error(`${scene.name}: "${text}" never showed\n${await terminal.text()}`);
        await sleep(20);
      }
    },
    async still(name) {
      const svg = join(OUT, `${name}.svg`);
      await terminal.screenshot(svg);
      rasterise(svg);
    },
  };
  await scene.play(driver);
  await terminal.write(scene.quit ?? CTRL_D);

  // asciinema writes the last events once the program exits.
  let size = -1;
  for (let tries = 0; tries < 40; tries++) {
    await sleep(150);
    const now = existsSync(cast) ? statSync(cast).size : -1;
    if (now === size && now > 0) break;
    size = now;
  }
  await terminal.closeQuiet();
  const { header, events } = readCast(cast);
  let kept = fromFirstFrame(untilExit(events), scene.ready);
  const gif = join(OUT, `${scene.name}.gif`);
  const fps = scene.fps ?? FPS;
  if (scene.loop) {
    const at = (name: string) => {
      const seconds = marks.get(name);
      if (seconds === undefined) throw new Error(`${scene.name}: no mark "${name}"`);
      return Math.round(seconds * fps);
    };
    const { from, to } = scene.loop;
    writeCast(cast, header, kept);
    render(cast, gif, { lastFrame: 1 / fps, idleLimit: 60, fps });
    const all = frames(gif, fps);
    const [start, end] = bestLoop(all, {
      from: from ? [at(from[0]), at(from[1])] : [0, all.length - 1],
      to: to
        ? () => [at(to[0]), at(to[1])]
        : (first) => [first + Math.round(LOOP_MIN_S * fps), first + Math.round(LOOP_MAX_S * fps)],
    });
    kept = window(kept, start / fps, end / fps);
    writeCast(cast, header, kept);
    render(cast, gif, { lastFrame: 1 / fps, idleLimit: 60, fps });
  } else {
    writeCast(cast, header, kept);
    render(cast, gif, { lastFrame: HOLD_S, idleLimit: IDLE_S, fps });
  }
  assertLoops(gif);
}

/** Frames per second a GIF is drawn at unless its scene asks for more. */
const FPS = 15;
/** Seconds a narrative scene holds its final frame before starting over. */
const HOLD_S = 2;
/** Longest pause a narrative scene keeps, in seconds. */
const IDLE_S = 1.5;
/** Lengths a seamless loop may take, in seconds. */
const LOOP_MIN_S = 5;
const LOOP_MAX_S = 10;
/** Size the frames of a loop are compared at: small enough to search every window. */
const PROBE_W = 160;
const PROBE_H = 91;

type CastEvent = [number, string, string];

function readCast(path: string): { header: Record<string, unknown>; events: CastEvent[] } {
  const [first = "{}", ...rest] = readFileSync(path, "utf8").split("\n");
  try {
    const { version, width, height, timestamp, idle_time_limit } = JSON.parse(first);
    // The recorded command and environment name local paths, so the header keeps only size and timing.
    const header = { version, width, height, timestamp, idle_time_limit, title: "pituitary (scripted demo)" };
    return { header, events: rest.flatMap((line) => (line ? [JSON.parse(line) as CastEvent] : [])) };
  } catch (cause) {
    throw new Error(`${path} is not an asciinema cast`, { cause });
  }
}

function writeCast(path: string, header: Record<string, unknown>, events: CastEvent[]): void {
  writeFileSync(path, `${[header, ...events].map((line) => JSON.stringify(line)).join("\n")}\n`);
}

const LEAVE_ALTERNATE = "\x1b[?1049l";

/** The events up to the program leaving the alternate screen, which blanks what it drew. */
function untilExit(events: CastEvent[]): CastEvent[] {
  const exit = events.findIndex(([, kind, data]) => kind === "o" && data.includes(LEAVE_ALTERNATE));
  if (exit === -1) return events;
  const [time, kind, data] = events[exit] as CastEvent;
  const before = data.slice(0, data.indexOf(LEAVE_ALTERNATE));
  return [...events.slice(0, exit), ...(before ? [[time, kind, before] as CastEvent] : [])];
}

/** Terminal escape sequences, dropped when looking for text in what a program wrote. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape and bell bytes are what a sequence is made of.
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])/g;
/** How long one frame takes to reach the terminal, in seconds; its writes all land within this. */
const FRAME_WRITE_S = 0.05;

/**
 * The cast starting on its first fully drawn frame: every event up to the frame that
 * shows `ready` keeps building the terminal, at time zero, and the rest shift to follow.
 */
function fromFirstFrame(events: CastEvent[], ready: string): CastEvent[] {
  let written = "";
  const shown = events.findIndex(([, kind, data]) => {
    if (kind !== "o") return false;
    written += data;
    return written.replace(ESCAPES, "").includes(ready);
  });
  if (shown === -1) return events;
  const drawn = (events[shown] as CastEvent)[0] + FRAME_WRITE_S;
  const start = Math.max(...events.flatMap(([time]) => (time <= drawn ? [time] : [])));
  return events.map(([time, kind, data]) => [time <= drawn ? 0 : time - start, kind, data]);
}

/** The cast played from `from` to just before `to`, seconds; earlier events build the state at time zero. */
function window(events: CastEvent[], from: number, to: number): CastEvent[] {
  return events.flatMap(([time, kind, data]): CastEvent[] =>
    time < to ? [[Math.max(0, time - from), kind, data]] : [],
  );
}

/** A GIF's frames sampled at `fps`, small, as RGB bytes. */
function frames(gif: string, fps: number): Uint8Array[] {
  const out = spawnSync(
    FFMPEG,
    [
      "-loglevel",
      "error",
      "-i",
      gif,
      "-vf",
      `fps=${fps},scale=${PROBE_W}:${PROBE_H}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  if (out.status !== 0) throw new Error(`ffmpeg failed on ${gif}: ${out.error ?? out.stderr}`);
  const size = PROBE_W * PROBE_H * 3;
  const all = new Uint8Array(out.stdout);
  return Array.from({ length: Math.floor(all.length / size) }, (_, index) =>
    all.subarray(index * size, (index + 1) * size),
  );
}

function difference(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs((a[index] ?? 0) - (b[index] ?? 0));
  return total / a.length;
}

/**
 * The frames `[from, to)` of the window whose first frame best matches the frame after its
 * last, so playing it on repeat shows no restart. Its first frame falls in `range.from`, and
 * its end in the range `range.to` gives for that first frame.
 */
function bestLoop(
  all: Uint8Array[],
  range: { from: [number, number]; to(first: number): [number, number] },
): [number, number] {
  let best: [number, number] = [0, all.length - 1];
  let score = Number.POSITIVE_INFINITY;
  const last = all.length - 1;
  for (let from = Math.max(0, range.from[0]); from <= Math.min(last, range.from[1]); from++) {
    const [low, high] = range.to(from);
    for (let to = Math.max(from + 1, low); to <= Math.min(last, high); to++) {
      const here = difference(all[from] as Uint8Array, all[to] as Uint8Array);
      if (here < score) {
        score = here;
        best = [from, to];
      }
    }
  }
  process.stdout.write(
    `  loop: frames ${best[0]}–${best[1]} of ${all.length}, mean difference ${score.toFixed(2)} of 255\n`,
  );
  return best;
}

/** Fails unless the GIF repeats forever: a NETSCAPE2.0 block with a loop count of zero. */
function assertLoops(gif: string): void {
  const bytes = readFileSync(gif);
  const at = bytes.indexOf("NETSCAPE2.0");
  if (at === -1 || bytes[at + 13] !== 0 || bytes[at + 14] !== 0)
    throw new Error(`${gif} does not loop forever`);
}

function render(
  cast: string,
  gif: string,
  timing: { lastFrame: number; idleLimit: number; fps: number },
): void {
  const result = spawnSync(
    AGG,
    [
      "--font-dir",
      NERD_FONT_DIR,
      "--font-family",
      "JetBrainsMono Nerd Font Mono",
      "--font-size",
      "18",
      "--line-height",
      "1.25",
      "--theme",
      THEME,
      "--idle-time-limit",
      String(timing.idleLimit),
      "--fps-cap",
      String(timing.fps),
      "--last-frame-duration",
      String(timing.lastFrame),
      cast,
      gif,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`agg failed on ${cast}: ${result.stderr}`);
}

function rasterise(svg: string): void {
  const fonts = process.env.PITUITARY_FONT_DIR;
  if (!fonts) return;
  const extra = [process.env.PITUITARY_SYMBOL_FONT_DIR, NERD_FONT_DIR].filter(Boolean) as string[];
  spawnSync("resvg", [
    "--skip-system-fonts",
    "--use-fonts-dir",
    fonts,
    ...extra.flatMap((dir) => ["--use-fonts-dir", dir]),
    "--font-family",
    "JetBrains Mono",
    "--zoom",
    "2",
    svg,
    svg.replace(/\.svg$/, ".png"),
  ]);
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const scene of scenes.filter((each) => wanted.length === 0 || wanted.includes(each.name))) {
  process.stdout.write(`recording ${scene.name}\n`);
  try {
    await record(scene);
  } catch (cause) {
    process.stdout.write(`  failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
await closeAll();
