import { homedir } from "node:os";
import { join } from "node:path";

export interface PiCommand {
  command: string;
  args: string[];
  prompt?: string;
  resume: boolean;
  direct: boolean;
}
export interface DuraOptions {
  run: string;
  state: string;
  task?: string;
  socket?: string;
  watch: boolean;
}

const VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--mode",
  "--session",
  "--session-id",
  "--session-dir",
  "--fork",
  "--name",
  "-n",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--export",
  "--tui-mode",
]);
const DIRECT_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--print",
  "-p",
  "--export",
  "--list-models",
]);
const SUBCOMMANDS = new Set(["auth", "mcp", "config", "install", "remove", "update", "list"]);

/** Pi arguments stay Pi arguments; only positional tasks move onto its RPC input. */
export function piCommand(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env): PiCommand {
  const command = environment.PI_AGENT_CMD ?? "pi";
  const prefix = environment.PI_AGENT_ARGS?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (SUBCOMMANDS.has(argv[0] ?? "") || argv.some((arg) => DIRECT_FLAGS.has(arg)))
    return { command, args: [...prefix, ...argv], resume: false, direct: true };
  const args = [...prefix],
    words: string[] = [];
  let resume = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--resume" || arg === "-r") {
      resume = true;
      continue;
    }
    if (arg.startsWith("-")) {
      args.push(arg);
      if (VALUE_FLAGS.has(arg) && argv[index + 1] !== undefined) args.push(argv[++index] as string);
    } else words.push(arg);
  }
  if (environment.PITUITARY_MODEL && !args.some((arg) => arg === "--model" || arg.startsWith("--model=")))
    args.push("--model", environment.PITUITARY_MODEL);
  return { command, args, resume, direct: false, ...(words.length ? { prompt: words.join(" ") } : {}) };
}

/** Managed work is selected explicitly; it never changes what a plain `pituitary` means. */
export function duraOptions(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): DuraOptions | undefined {
  if (!argv.includes("--dura")) return;
  const options: Partial<DuraOptions> = { watch: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--watch") {
      options.watch = true;
      continue;
    }
    const key =
      arg === "--dura"
        ? "run"
        : arg === "--state"
          ? "state"
          : arg === "--task"
            ? "task"
            : arg === "--socket"
              ? "socket"
              : undefined;
    if (!key) throw new Error(`Unknown Dura frontend option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[key] = value;
  }
  options.state ??=
    environment.DURA_STATE_DIR ??
    join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "dura");
  options.socket ??= environment.DURA_RUNTIME_SOCKET;
  if (!options.run)
    throw new Error("Use pituitary --dura RUN [--state DIRECTORY] [--task TASK] [--socket PATH] [--watch]");
  return options as DuraOptions;
}

const SESSION_FLAGS = new Map([
  ["--continue", false],
  ["-c", false],
  ["--resume", false],
  ["-r", false],
  ["--session", true],
  ["--session-id", true],
  ["--fork", true],
  ["--model", true],
  ["--provider", true],
  ["--thinking", true],
  ["--name", true],
  ["-n", true],
]);

/** Resume the session as Pi last saved it, without replaying initial model/session overrides. */
export function resumePiArgs(args: readonly string[], sessionFile?: string): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const flag = arg.split("=", 1)[0] as string;
    if (!SESSION_FLAGS.has(flag)) kept.push(arg);
    else if (SESSION_FLAGS.get(flag) && !arg.includes("=")) index++;
  }
  return sessionFile ? [...kept, "--session", sessionFile] : kept;
}
