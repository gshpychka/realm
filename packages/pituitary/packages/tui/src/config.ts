import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentCommand {
  command: string;
  args: string[];
  /** Open on the session picker, as `pi --resume` does. */
  resume: boolean;
  /** Text given on the command line, sent as the first prompt. */
  prompt: string | null;
  /** The arguments ask pi for something other than a session, so pi runs them itself. */
  direct: boolean;
}

/** pi's flags that take a value, so the word after one is its value, not a prompt. */
const VALUE_FLAGS = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--mode",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
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

/** Flags that make pi print something and exit, which it does better on its own. */
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

/**
 * The process the UI talks to over RPC: pi from PATH, given the UI's own arguments,
 * so `pituitary --continue --model sonnet` opens pi the way `pi --continue --model sonnet` would.
 *
 * pi in RPC mode takes no prompt and draws no session picker, so this client does both.
 * PI_AGENT_CMD and PI_AGENT_ARGS point the UI at a scripted agent for tests.
 */
export function resolveAgentCommand(argv: readonly string[] = process.argv.slice(2)): AgentCommand {
  const command = process.env.PI_AGENT_CMD ?? "pi";
  const raw = process.env.PI_AGENT_ARGS?.trim();
  const args: string[] = raw ? raw.split(/\s+/) : [];
  const words: string[] = [];
  let resume = false;
  let direct = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--resume" || arg === "-r") {
      resume = true;
      continue;
    }
    if (DIRECT_FLAGS.has(arg)) direct = true;
    if (arg.startsWith("-")) {
      args.push(arg);
      const value = argv[index + 1];
      if (VALUE_FLAGS.has(arg) && value !== undefined) {
        args.push(value);
        index++;
      }
      continue;
    }
    words.push(arg);
  }
  if (direct) return { command, args: [...argv], resume: false, prompt: null, direct };
  return { command, args, resume, prompt: words.length > 0 ? words.join(" ") : null, direct };
}

/** Flags that pick a session or override what it holds, with whether each takes a value. */
const SESSION_CHOICE = new Map<string, boolean>([
  ["--continue", false],
  ["-c", false],
  ["--session", true],
  ["--session-id", true],
  ["--fork", true],
  ["--model", true],
  ["--provider", true],
  ["--thinking", true],
  ["--name", true],
  ["-n", true],
]);

/**
 * `args` for a pi that carries on in `sessionFile`: the flags that chose the first session,
 * or overrode its model, give way to the session as pi last saved it.
 */
export function resumeArgs(args: readonly string[], sessionFile: string | undefined): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const takesValue = SESSION_CHOICE.get(arg);
    if (takesValue === undefined) kept.push(arg);
    else if (takesValue) index++;
  }
  return sessionFile ? [...kept, "--session", sessionFile] : kept;
}

export interface Log {
  write(chunk: string): void;
}

/**
 * Diagnostics sink.
 *
 * Anything written to the UI's own stdout or stderr lands in the rendered frame,
 * so the agent's stderr and any UI errors go to PITUITARY_LOG instead.
 */
export function openLog(): Log {
  const path = process.env.PITUITARY_LOG;
  if (!path) return { write: () => {} };
  mkdirSync(dirname(path), { recursive: true });
  return {
    write: (chunk) => {
      try {
        appendFileSync(path, chunk);
      } catch {
        // A failed diagnostic write must not take the UI down.
      }
    },
  };
}
