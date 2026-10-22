#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plain } from "@pituitary/rpc";
import { loadCatalog } from "./catalog.ts";
import { Runtime } from "./runtime.ts";
import type { Run } from "./store.ts";

const VERBS = ["run", "attach", "runs", "agents", "inspect", "recover", "stop", "serve"] as const;
type Verb = (typeof VERBS)[number];
const HELP = `Usage:
  pituitary run [--agent ROLE] [--repo OWNER/NAME@REF] [--name NAME] [--cwd DIR] [--detach] [OBJECTIVE]
  pituitary agents [--json] [--catalog FILE]
  pituitary attach RUN [--task TASK]
  pituitary runs [--json]
  pituitary inspect RUN [--json]
  pituitary recover RUN
  pituitary stop RUN
  pituitary serve [--catalog FILE]

Runs keep their worker alive when the terminal closes. Stop ends the worker explicitly.
All commands accept --state DIR (or PITUITARY_STATE_DIR) for an isolated workspace.
Ordinary pituitary and Pi options continue to use the existing single-agent interface.
`;

export type Command = {
  state: string;
  help: false;
} & (
  | {
      verb: "run";
      name?: string;
      cwd: string;
      prompt?: string;
      detach: boolean;
      agent?: string;
      repos: string[];
      catalogFile?: string;
    }
  | { verb: "runs"; json: boolean }
  | { verb: "agents"; json: boolean; catalogFile?: string }
  | { verb: "serve"; catalogFile?: string }
  | { verb: "attach"; name: string; json: boolean; taskId?: string }
  | { verb: Exclude<Verb, "run" | "runs" | "agents" | "attach" | "serve">; name: string; json: boolean }
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
  let agent: string | undefined;
  let catalogFile: string | undefined;
  let taskId: string | undefined;
  const repos: string[] = [];
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
    if (seen.has(arg) && arg !== "--repo") throw new Error(`Option ${arg} was supplied more than once`);
    seen.add(arg);
    if (arg === "--detach" && verb === "run") {
      detach = true;
      continue;
    }
    if (arg === "--json" && ["runs", "agents", "inspect"].includes(verb)) {
      json = true;
      continue;
    }
    if (
      arg === "--state" ||
      (["--cwd", "--name", "--agent", "--repo"].includes(arg) && verb === "run") ||
      (arg === "--catalog" && ["run", "agents", "serve"].includes(verb)) ||
      (arg === "--task" && verb === "attach")
    ) {
      const value = remaining.next().value;
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--state") state = resolve(value);
      if (arg === "--cwd") cwd = resolve(value);
      if (arg === "--name") name = value;
      if (arg === "--agent") agent = value;
      if (arg === "--repo") repos.push(value);
      if (arg === "--catalog") catalogFile = resolve(value);
      if (arg === "--task") taskId = value;
      continue;
    }
    throw new Error(`Unknown option ${arg} for ${verb}`);
  }
  if (help) return { help: true, state };
  if (verb === "run") {
    if (repos.length && !agent) throw new Error("--repo requires --agent");
    return {
      verb,
      state,
      name,
      cwd,
      prompt: words.join(" ") || undefined,
      detach,
      agent,
      repos,
      catalogFile,
      help: false,
    };
  }
  if (verb === "runs") {
    if (words.length) throw new Error("runs does not take a run name");
    return { verb, state, json, help: false };
  }
  if (verb === "agents") {
    if (words.length) throw new Error("agents does not take a run name");
    return { verb, state, json, catalogFile, help: false };
  }
  if (verb === "serve") {
    if (words.length) throw new Error("serve does not take a run name");
    return { verb, state, catalogFile, help: false };
  }
  const target = words[0];
  if (words.length !== 1 || !target) throw new Error(`${verb} requires exactly one run name or ID`);
  return { verb, state, name: target, json, ...(verb === "attach" && taskId ? { taskId } : {}), help: false };
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
  if (command.verb === "agents") {
    const catalog = loadCatalog(command.catalogFile);
    if (command.json) process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    else
      for (const [name, agent] of Object.entries(catalog.agents))
        process.stdout.write(`${name.padEnd(18)} ${plain(agent.manifest.description)}\n`);
    return;
  }
  if (command.verb === "serve") {
    const { serveRuntime } = await import("./supervisor.ts");
    await serveRuntime({ stateDirectory: command.state, catalogFile: command.catalogFile });
    return;
  }
  const runtime = new Runtime({
    stateDirectory: command.state,
    catalogFile: command.verb === "run" ? command.catalogFile : undefined,
  });
  try {
    if (command.verb === "run") {
      const run = await runtime.start({
        name: command.name,
        cwd: command.cwd,
        prompt: command.prompt,
        agent: command.agent,
        repos: command.repos,
      });
      if (command.detach) process.stdout.write(`${run.name}\n`);
      else await attach(run, command.state);
    } else if (command.verb === "attach") {
      const detail = await runtime.inspect(command.name);
      await attach(detail.run, command.state, command.taskId);
    } else if (command.verb === "runs") {
      const runs = await Promise.all((await runtime.list()).map((run) => runtime.inspect(run.id)));
      if (command.json) process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
      else if (!runs.length) process.stdout.write("No managed runs. Start one with pituitary run.\n");
      else
        for (const detail of runs) {
          const root = detail.tasks.find((task) => task.id === detail.run.rootTaskId);
          process.stdout.write(
            `${detail.run.name.padEnd(18)} ${(root?.status ?? detail.run.desired).padEnd(12)} ${plain(detail.run.cwd)}\n`,
          );
        }
    } else if (command.verb === "inspect") {
      const detail = await runtime.inspect(command.name);
      const run = detail.run;
      if (command.json) process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      else {
        process.stdout.write(`${run.name} · ${run.desired}\n${plain(run.cwd)}\n${plain(run.objective)}\n`);
        for (const task of detail.tasks) {
          const attempt = detail.attempts.find((item) => item.id === task.currentAttemptId);
          process.stdout.write(
            `${task.id}  ${task.role ?? "solo"}  ${task.status} / ${attempt?.status ?? "unknown"}\n`,
          );
          if (attempt?.error) process.stdout.write(`  Attention: ${plain(attempt.error)}\n`);
          if (task.report)
            process.stdout.write(
              `  Report (unverified, SHA-256 ${task.report.digest}):\n${plain(task.report.text)
                .split("\n")
                .map((line) => `    ${line}`)
                .join("\n")}\n`,
            );
        }
        process.stdout.write(`History: ${detail.events.length} recorded transitions\n`);
      }
    } else if (command.verb === "recover") {
      const run = await runtime.recover(command.name);
      process.stdout.write(`Recovered ${run.name}.\n`);
    } else {
      const run = await runtime.stop(command.name);
      process.stdout.write(`Stopping ${run.name}. Conversations and workspaces are retained.\n`);
    }
  } finally {
    runtime.close();
  }
}

async function attach(run: Run, state: string, taskId?: string): Promise<void> {
  delete process.env.PITUITARY_WORKER_SOCKET;
  if (taskId) process.env.PITUITARY_TASK_ID = taskId;
  else delete process.env.PITUITARY_TASK_ID;
  process.env.PITUITARY_RUN_ID = run.id;
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
