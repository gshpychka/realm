import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The commands shared by the development driver and its CLI. */
export interface Command {
  op: string;
  args: string[];
  options: Record<string, string>;
}

const OPTIONS: Record<string, readonly string[]> = {
  start: ["pi", "env", "scenario", "delay", "cols", "rows", "entry", "ready", "settle", "tmux"],
  type: [],
  submit: [],
  key: [],
  write: [],
  wait: ["timeout"],
  screen: ["style"],
  capture: [],
  resize: [],
  stop: [],
  help: [],
};
const SWITCHES = new Set(["style", "tmux"]);

export function driverSocket(
  name = process.env.TUI_SESSION ?? "default",
  workspace = join(import.meta.dirname, ".."),
): string {
  if (!/^[\w-]{1,40}$/.test(name)) {
    throw new Error("TUI_SESSION must be 1–40 letters, numbers, underscores, or hyphens");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("the development driver requires a Unix platform");
  // Unix socket paths are limited to roughly 100 bytes. Neither a checkout's path
  // nor macOS's long TMPDIR can safely be part of the socket's address.
  const key = createHash("sha256").update(resolve(workspace)).update("\0").update(name).digest("hex");
  return join("/tmp", `pituitary-drive-${uid}`, `${key.slice(0, 24)}.sock`);
}

/** The driver accepts commands and environment values, so only its operator may connect. */
export function prepareDriverSocket(): string {
  const socket = driverSocket();
  const directory = dirname(socket);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`driver socket directory is not owned by this operator: ${directory}`);
  }
  chmodSync(directory, 0o700);
  return socket;
}

export const HELP = `Usage: just tui <command> [arguments]

start [--scenario tool] [--delay 40] [--cols 100 --rows 28]
      [--pi 'arguments or JSON array'] [--env 'KEY=value;KEY2=value']
      [--entry path --ready text] [--settle false] [--tmux]
submit [text]        send text, or the current draft
type text            type into the editor
key esc down enter   press named keys (also ctrl+letter, alt+character)
write bytes          send raw terminal input
wait text [--timeout 10000]
screen [--style]     inspect the screen and optionally its colours
capture [name]       save text, SVG and PNG under artifacts/screens
resize columns rows
stop

Use -- before literal text beginning with a dash.
TUI_SESSION=name keeps a separate live session.`;

export function parseCommand(argv: readonly string[]): Command {
  const [word = "screen", ...rest] = argv;
  const op = word === "--help" || word === "-h" ? "help" : word;
  if (!Object.hasOwn(OPTIONS, op)) throw new Error(`unknown command "${op}"; use 'just tui help'`);
  const command: Command = { op, args: [], options: {} };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? "";
    if (arg === "--") {
      command.args.push(...rest.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      command.args.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    if (!OPTIONS[op]?.includes(name)) throw new Error(`unknown option --${name} for ${op}`);
    if (SWITCHES.has(name)) {
      if (equals >= 0) throw new Error(`--${name} takes no value`);
      command.options[name] = "";
      continue;
    }
    const value = equals >= 0 ? arg.slice(equals + 1) : rest[++index];
    if (value === undefined || (value.startsWith("--") && OPTIONS[op]?.includes(value.slice(2)))) {
      throw new Error(`--${name} needs a value`);
    }
    command.options[name] = value;
  }
  return validateCommand(command);
}

/** Validate direct socket callers too; malformed input must not crash the driver. */
export function validateCommand(value: unknown): Command {
  if (!value || typeof value !== "object") throw new Error("not a command");
  const command = value as Command;
  if (
    typeof command.op !== "string" ||
    !Object.hasOwn(OPTIONS, command.op) ||
    !Array.isArray(command.args) ||
    !command.args.every((arg) => typeof arg === "string") ||
    !command.options ||
    typeof command.options !== "object" ||
    Array.isArray(command.options)
  )
    throw new Error("not a command");
  const { op, args, options } = command;
  for (const [name, option] of Object.entries(options)) {
    if (!OPTIONS[op]?.includes(name) || typeof option !== "string") throw new Error(`invalid option ${name}`);
  }
  const noArgs = ["start", "screen", "stop", "help"].includes(op);
  if (noArgs && args.length) throw new Error(`${op} takes no arguments`);
  if (["type", "key", "write", "wait"].includes(op) && !args.length)
    throw new Error(`${op} needs an argument`);
  if (op === "resize") {
    if (args.length !== 2) throw new Error("resize needs columns and rows");
    for (const size of args) positiveInteger(size, "terminal size");
  }
  if (op === "capture" && (args.length > 1 || (args[0] !== undefined && !/^[\w-]+$/.test(args[0])))) {
    throw new Error("capture name must contain only letters, numbers, underscores, or hyphens");
  }
  for (const name of ["cols", "rows", "timeout"]) {
    if (options[name] !== undefined) positiveInteger(options[name], `--${name}`);
  }
  if (
    options.delay !== undefined &&
    (!/^\d+$/.test(options.delay) || !Number.isSafeInteger(Number(options.delay)))
  ) {
    throw new Error("--delay must be a nonnegative integer");
  }
  if (options.settle !== undefined && !["true", "false"].includes(options.settle))
    throw new Error("--settle must be true or false");
  if (options.env !== undefined) environment(options.env);
  if (options.pi !== undefined) piArguments(options.pi);
  return command;
}

function positiveInteger(value: string, name: string): void {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function environment(pairs: string): Record<string, string> {
  return Object.fromEntries(
    pairs
      .split(";")
      .filter(Boolean)
      .map((pair) => {
        const equals = pair.indexOf("=");
        if (equals < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair.slice(0, equals))) {
          throw new Error(`invalid environment assignment ${JSON.stringify(pair)}; use KEY=value`);
        }
        return [pair.slice(0, equals), pair.slice(equals + 1)];
      }),
  );
}

export function piArguments(value: string): string[] {
  if (!value.trimStart().startsWith("[")) return value.trim().split(/\s+/).filter(Boolean);
  try {
    const args: unknown = JSON.parse(value);
    if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) return args;
  } catch {
    /* The CLI shows the same actionable error for invalid syntax and shape. */
  }
  throw new Error("--pi must be arguments or a JSON array of strings");
}
