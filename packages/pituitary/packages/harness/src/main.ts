#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plain } from "@pituitary/rpc";
import { Runtime } from "./runtime.ts";
import type { Run } from "./store.ts";

const VERBS = ["run", "attach", "runs", "inspect", "stop"] as const;
type Verb = (typeof VERBS)[number];
const HELP = `Usage:
  pituitary run [--name NAME] [--cwd DIR] [--detach] [OBJECTIVE]
  pituitary attach RUN
  pituitary runs [--json]
  pituitary inspect RUN [--json]
  pituitary stop RUN

Runs keep their worker alive when the terminal closes. Stop ends the worker explicitly.
All commands accept --state DIR (or PITUITARY_STATE_DIR) for an isolated workspace.
Ordinary pituitary and Pi options continue to use the existing single-agent interface.
`;

export type Command = {
  state: string;
  help: false;
} & (
  | { verb: "run"; name?: string; cwd: string; prompt?: string; detach: boolean }
  | { verb: "runs"; json: boolean }
  | { verb: Exclude<Verb, "run" | "runs">; name: string; json: boolean }
);

type Help = { help: true; state: string };

function isVerb(value: string | undefined): value is Verb {
  return VERBS.some((verb) => verb === value);
}

export function parseCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Command | Help {
  const verb = args[0];
  if (!isVerb(verb)) throw new Error(`Expected ${VERBS.join(", ")}`);
  let state =
    environment.PITUITARY_STATE_DIR ??
    join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pituitary");
  let cwd = process.cwd();
  let name: string | undefined;
  let detach = false;
  let json = false;
  let help = false;
  const words: string[] = [];
  const seen = new Set<string>();
  const remaining = args.slice(1).values();
  for (const arg of remaining) {
    if (arg === "--") {
      words.push(...remaining);
      break;
    }
    if (!arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (seen.has(arg)) throw new Error(`Option ${arg} was supplied more than once`);
    seen.add(arg);
    if (arg === "--detach" && verb === "run") {
      detach = true;
      continue;
    }
    if (arg === "--json" && ["runs", "inspect"].includes(verb)) {
      json = true;
      continue;
    }
    if (arg === "--state" || ((arg === "--cwd" || arg === "--name") && verb === "run")) {
      const value = remaining.next().value;
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--state") state = resolve(value);
      if (arg === "--cwd") cwd = resolve(value);
      if (arg === "--name") name = value;
      continue;
    }
    throw new Error(`Unknown option ${arg} for ${verb}`);
  }
  if (help) return { help: true, state };
  if (verb === "run") {
    return { verb, state, name, cwd, prompt: words.join(" ") || undefined, detach, help: false };
  }
  if (verb === "runs") {
    if (words.length) throw new Error("runs does not take a run name");
    return { verb, state, json, help: false };
  }
  const target = words[0];
  if (words.length !== 1 || !target) throw new Error(`${verb} requires exactly one run name or ID`);
  return { verb, state, name: target, json, help: false };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!isVerb(args[0])) {
    await import("../../tui/src/main.tsx");
    return;
  }
  const command = parseCommand(args);
  if (command.help) {
    process.stdout.write(HELP);
    return;
  }
  const runtime = new Runtime({ stateDirectory: command.state });
  try {
    if (command.verb === "run") {
      const run = await runtime.start({ name: command.name, cwd: command.cwd, prompt: command.prompt });
      if (command.detach) process.stdout.write(`${run.name}\n`);
      else await attach(run, command.state);
    } else if (command.verb === "attach") {
      const run = await runtime.inspect(command.name);
      if (!["ready", "busy"].includes(run.status))
        throw new Error(`Run ${run.name} is ${run.status}${run.error ? `: ${run.error}` : ""}`);
      await attach(run, command.state);
    } else if (command.verb === "runs") {
      const runs = await Promise.all(runtime.store.list().map((run) => runtime.inspect(run.id)));
      if (command.json) process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
      else if (!runs.length) process.stdout.write("No managed runs. Start one with pituitary run.\n");
      else
        for (const run of runs)
          process.stdout.write(`${run.name.padEnd(18)} ${run.status.padEnd(12)} ${plain(run.cwd)}\n`);
    } else if (command.verb === "inspect") {
      const run = await runtime.inspect(command.name);
      const events = runtime.store.events(run.id);
      if (command.json) process.stdout.write(`${JSON.stringify({ ...run, events }, null, 2)}\n`);
      else {
        process.stdout.write(`${run.name} · ${run.status}\n${plain(run.cwd)}\n`);
        if (run.sessionId) process.stdout.write(`Conversation: ${run.sessionId}\n`);
        if (run.promptStatus) process.stdout.write(`Initial prompt: ${run.promptStatus}\n`);
        if (run.error) process.stdout.write(`Attention: ${plain(run.error)}\n`);
        process.stdout.write(`History: ${events.length} recorded transitions\n`);
      }
    } else {
      const run = await runtime.stop(command.name);
      process.stdout.write(`Stopped ${run.name}. Conversation history is in ${plain(run.directory)}.\n`);
    }
  } finally {
    runtime.close();
  }
}

async function attach(run: Run, state: string): Promise<void> {
  process.env.PITUITARY_WORKER_SOCKET = run.socket;
  process.env.PITUITARY_RUN_NAME = run.name;
  process.env.PITUITARY_STATE_DIR = resolve(state);
  process.chdir(run.cwd);
  process.argv = [process.execPath, fileURLToPath(new URL("../../tui/src/main.tsx", import.meta.url))];
  await import("../../tui/src/main.tsx");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`pituitary: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
