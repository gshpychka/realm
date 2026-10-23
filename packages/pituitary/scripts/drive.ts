/**
 * Holds one live UI session in a headless terminal and serves commands for it over a
 * unix socket, so the UI can be operated step by step from separate shell commands.
 *
 * tui-test sessions live only as long as the process that opened them, which is what
 * this process is for. `scripts/tui.ts` is the client and starts it on demand.
 */
import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { TuiTest } from "@microsoft/tui-test";
import { boot, COLS, type Harness, launch, REPO, ROWS } from "../e2e/helpers/harness.ts";
import {
  type Command,
  driverSocket,
  environment,
  HELP,
  prepareDriverSocket,
  validateCommand,
} from "./tui-command.ts";

/** One driver per name, so several operators can each hold a session; `TUI_SESSION` picks it. */
const SOCKET = driverSocket();

/** Raw bytes a terminal sends for each named key. */
const KEYS = new Map(
  Object.entries({
    esc: "\x1b",
    enter: "\r",
    tab: "\t",
    space: " ",
    "shift+tab": "\x1b[Z",
    backspace: "\x7f",
    delete: "\x1b[3~",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    pgup: "\x1b[5~",
    pgdn: "\x1b[6~",
    "alt+enter": "\x1b\r",
    "shift+enter": "\x1b[13;2u",
    "alt+up": "\x1b[1;3A",
    "alt+down": "\x1b[1;3B",
  }),
);

/** The bytes for `name`: a named key, ctrl+letter, or alt+character. */
export function keyBytes(name: string): string {
  const known = KEYS.get(name);
  if (known) return known;
  if ([...name].length === 1) return name;
  const ctrl = /^ctrl\+([a-z\]\\[^_])$/.exec(name);
  if (ctrl?.[1]) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
  const alt = /^alt\+(.)$/.exec(name);
  if (alt?.[1]) return `\x1b${alt[1]}`;
  throw new Error(`unknown key "${name}"; known: ${[...KEYS.keys()].join(", ")}, ctrl+<letter>, alt+<char>`);
}

let session: Harness | null = null;

function live(): TuiTest {
  if (!session) throw new Error("no session; run `just tui start` first");
  return session.terminal;
}

/** The screen as text, with each styled run listed under it by row and column. */
async function styled(terminal: TuiTest): Promise<string> {
  const { cols, rows } = await terminal.getSize();
  const cells = await terminal.cells(0, 0, cols, rows);
  const text: string[] = [];
  const runs: string[] = [];
  // Blank runs on the screen's own background carry nothing worth reading.
  const counts = new Map<string, number>();
  for (const cell of cells) counts.set(String(cell.bg), (counts.get(String(cell.bg)) ?? 0) + 1);
  const ground = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (let row = 0; row < rows; row++) {
    const line = cells.slice(row * cols, (row + 1) * cols);
    text.push(
      line
        .map((cell) => cell.char || "")
        .join("")
        .trimEnd(),
    );
    let start = 0;
    for (let col = 1; col <= line.length; col++) {
      const here = line[col];
      const first = line[start];
      if (!first) break;
      if (here && same(here, first)) continue;
      const chunk = line
        .slice(start, col)
        .map((cell) => cell.char || "")
        .join("");
      if (chunk.trim() || String(first.bg) !== ground) {
        runs.push(
          `${String(row).padStart(2)} [${start},${col}) ${describe(first)} ${JSON.stringify(chunk.trimEnd())}`,
        );
      }
      start = col;
    }
  }
  const cursor = await terminal.getCursor();
  return `${text.join("\n")}\n\n── styles (row [from,to) fg on bg) · ground ${ground} · cursor ${cursor.y},${cursor.x}\n${runs.join("\n")}`;
}

type StyledCell = Awaited<ReturnType<TuiTest["cells"]>>[number];

function same(a: StyledCell, b: StyledCell): boolean {
  return (
    a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic && a.inverse === b.inverse
  );
}

function describe(cell: StyledCell): string {
  const marks = [cell.bold ? "bold" : "", cell.italic ? "italic" : "", cell.inverse ? "inverse" : ""].filter(
    Boolean,
  );
  return `${cell.fg} on ${cell.bg}${marks.length ? ` ${marks.join(" ")}` : ""}`;
}

type Op = (args: readonly string[], options: Readonly<Record<string, string>>) => Promise<string>;

/** An op that acts on the live session, then answers with the screen once output pauses. */
const acting =
  (act: (args: readonly string[]) => Promise<void>): Op =>
  async (args) => {
    await act(args);
    return settle();
  };

/** What each command does with the live session, by its name. */
const OPS = new Map<string, Op>([
  [
    "start",
    async (_args, options) => {
      await session?.close();
      session = null;
      session = await open(options);
      return live().text();
    },
  ],
  ["type", acting((args) => live().type(args.join(" ")))],
  ["submit", acting((args) => live().submit(args.length ? args.join(" ") : undefined))],
  [
    "key",
    acting(async (args) => {
      for (const bytes of args.map(keyBytes)) await live().write(bytes);
    }),
  ],
  ["write", acting((args) => live().write(args.join(" ")))],
  [
    "wait",
    async (args, options) => {
      await live().waitText(args.join(" "), { timeout: Number(options.timeout ?? 10_000) });
      return live().text();
    },
  ],
  ["screen", (_args, options) => (options.style === undefined ? live().text() : styled(live()))],
  ["help", async () => HELP],
  [
    "capture",
    async (args) => {
      if (!session) throw new Error("no session");
      const name = args[0] ?? "drive";
      await session.capture(name);
      return `captured artifacts/screens/${name}.{txt,svg,png}`;
    },
  ],
  ["resize", acting((args) => live().resize(Number(args[0]), Number(args[1])))],
  [
    "stop",
    async () => {
      await session?.close();
      session = null;
      rmSync(SOCKET, { force: true });
      setTimeout(() => process.exit(0), 50);
      return "stopped";
    },
  ],
]);

function run(value: unknown): Promise<string> {
  const { op, args, options } = validateCommand(value);
  const known = OPS.get(op);
  if (!known) throw new Error(`unknown command "${op}"`);
  return known(args, options);
}

/** The session `start` asks for: an entry point under the harness, or the UI against an agent. */
function open(options: Record<string, string>): Promise<Harness> {
  const size = { cols: Number(options.cols ?? COLS), rows: Number(options.rows ?? ROWS) };
  if (options.entry) {
    const settle = options.settle !== "false";
    return boot({
      entry: join(REPO, options.entry),
      ready: options.ready ?? "",
      settle,
      env: options.env ? environment(options.env) : undefined,
      tmux: options.tmux !== undefined,
      ...size,
    });
  }
  return launch({
    ...size,
    scenario: options.scenario,
    delayMs: options.delay ? Number(options.delay) : undefined,
    env: options.env ? environment(options.env) : undefined,
    settle: options.settle !== "false",
    tmux: options.tmux !== undefined,
  });
}

/** The screen once output pauses, so a keypress is seen with its effect. */
async function settle(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return live().text();
}

// UI operations share a renderer and must finish in order, even across CLI processes.
let pending: Promise<unknown> = Promise.resolve();
function serve(socket: Socket): void {
  // Closing a CLI while an operation is pending does not close the live UI.
  socket.on("error", () => {});
  let buffer = "";
  let handled = false;
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk.toString();
    const end = buffer.indexOf("\n");
    if (end === -1) return;
    handled = true;
    let command: Command;
    try {
      command = JSON.parse(buffer.slice(0, end)) as Command;
    } catch {
      // A line that is not a command is turned away, and the driver serves on.
      socket.end(`${JSON.stringify({ ok: false, output: "not a command" })}\n`);
      return;
    }
    const result = pending.then(() => run(command));
    pending = result.catch(() => {});
    result
      .then((output) => socket.end(`${JSON.stringify({ ok: true, output })}\n`))
      .catch((error: unknown) =>
        socket.end(
          `${JSON.stringify({ ok: false, output: error instanceof Error ? error.message : String(error) })}\n`,
        ),
      );
  });
}

if (process.argv[1] === import.meta.filename) {
  prepareDriverSocket();
  createServer(serve).listen(SOCKET);
  const quit = async () => {
    await session?.close();
    rmSync(SOCKET, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}
