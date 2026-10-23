#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { plain } from "@pituitary/session";
import { ensureLocalRuntime } from "./bootstrap.ts";
import { loadCatalog } from "./catalog.ts";
import { Runtime, runtimeSocket } from "./client.ts";
import type { ReviseTaskInput, Run } from "./model.ts";

const VERBS = [
  "run",
  "attach",
  "runs",
  "agents",
  "inspect",
  "recover",
  "stop",
  "serve",
  "answer",
  "retry",
  "revise",
  "integrate",
  "apply",
  "socket",
] as const;
type Verb = (typeof VERBS)[number];
const MUTATIONS: readonly Verb[] = [
  "run",
  "recover",
  "stop",
  "answer",
  "retry",
  "revise",
  "integrate",
  "apply",
];
const HELP = `Usage:
  dura [--model PROVIDER/MODEL] [OBJECTIVE]
  dura run [--agent ROLE] [--repo OWNER/NAME@REF] [--name NAME] [--cwd DIR] [--detach] [--watch] [OBJECTIVE]
  dura run --agent ROLE --workspace DIR [--include-untracked PATH] [OBJECTIVE]
  dura agents [--json] [--catalog FILE]
  dura attach RUN [--task TASK] [--watch]
  dura runs [--json]
  dura inspect RUN [--json]
  dura answer QUESTION ANSWER
  dura retry TASK --revision N
  dura revise TASK --revision N [--input-artifact ID] [--depends-on TASK] [--accept CONDITION] [OBJECTIVE]
  dura integrate TASK --revision N
  dura apply RUN [--json]
  dura recover RUN
  dura stop RUN
  dura socket
  dura serve [--catalog FILE]

--workspace captures tracked working files without changing the operator's branch or index.
Untracked files enter the snapshot only when selected explicitly. Apply requires current independent checks.
Runs keep working when the terminal closes. Stop retains conversations and VM workspaces.
--watch reloads the frontend while the host harness keeps running.
Revisions accept --clear-dependencies and --clear-acceptance to replace those lists with empty lists.
Mutating commands accept --command-id KEY; reuse it after an uncertain result to recover the same command.
Client commands accept --socket PATH (or DURA_RUNTIME_SOCKET) for an existing runtime, including SSH tunnels.
All commands accept --state DIR (or DURA_STATE_DIR) for local runtime state.
Without a command, Dura starts a local durable conversation.
`;

type Common = { state: string; socketPath?: string; commandId?: string; help: false };
export type Command = Common &
  (
    | {
        verb: "run";
        name?: string;
        cwd: string;
        prompt?: string;
        detach: boolean;
        watch: boolean;
        agent?: string;
        model?: string;
        repos: string[];
        catalogFile?: string;
        workspace?: { includeUntracked: string[] };
      }
    | { verb: "runs"; json: boolean }
    | { verb: "agents"; json: boolean; catalogFile?: string }
    | { verb: "serve"; catalogFile?: string }
    | { verb: "attach"; name: string; json: boolean; taskId?: string; watch: boolean }
    | { verb: "inspect" | "recover" | "stop" | "apply"; name: string; json: boolean }
    | { verb: "answer"; questionId: string; answer: string }
    | { verb: "retry" | "integrate"; taskId: string; revision: number }
    | { verb: "revise"; taskId: string; revision: number; input: ReviseTaskInput }
    | { verb: "socket" }
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
    environment.DURA_STATE_DIR ??
    join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "dura");
  let cwd = process.cwd(),
    socketPath = environment.DURA_RUNTIME_SOCKET;
  let name: string | undefined,
    agent: string | undefined,
    catalogFile: string | undefined,
    taskId: string | undefined,
    workspacePath: string | undefined,
    revision: number | undefined,
    inputArtifactId: string | undefined;
  let commandId: string | undefined;
  let model: string | undefined;
  let detach = false,
    watch = false,
    json = false,
    help = false;
  const repos: string[] = [],
    untracked: string[] = [],
    dependsOn: string[] = [],
    acceptance: string[] = [],
    words: string[] = [];
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
    if (seen.has(arg) && !["--repo", "--include-untracked", "--depends-on", "--accept"].includes(arg))
      throw new Error(`Option ${arg} was supplied more than once`);
    seen.add(arg);
    if (verb === "revise" && ["--clear-dependencies", "--clear-acceptance"].includes(arg)) continue;
    if (arg === "--detach" && verb === "run") {
      detach = true;
      continue;
    }
    if (arg === "--watch" && ["run", "attach"].includes(verb)) {
      watch = true;
      continue;
    }
    if (arg === "--json" && ["runs", "agents", "inspect", "apply"].includes(verb)) {
      json = true;
      continue;
    }
    if (
      arg === "--state" ||
      (arg === "--command-id" && MUTATIONS.includes(verb)) ||
      (arg === "--socket" && !["serve", "agents"].includes(verb)) ||
      (["--cwd", "--name", "--agent", "--model", "--repo", "--workspace", "--include-untracked"].includes(
        arg,
      ) &&
        verb === "run") ||
      (arg === "--catalog" && ["run", "agents", "serve"].includes(verb)) ||
      (arg === "--task" && verb === "attach") ||
      (arg === "--revision" && ["retry", "revise", "integrate"].includes(verb)) ||
      (["--input-artifact", "--depends-on", "--accept"].includes(arg) && verb === "revise")
    ) {
      const value = remaining.next().value;
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--state") state = resolve(value);
      if (arg === "--command-id") commandId = value;
      if (arg === "--socket") socketPath = resolve(value);
      if (arg === "--cwd") cwd = resolve(value);
      if (arg === "--name") name = value;
      if (arg === "--agent") agent = value;
      if (arg === "--model") model = value;
      if (arg === "--repo") repos.push(value);
      if (arg === "--catalog") catalogFile = resolve(value);
      if (arg === "--task") taskId = value;
      if (arg === "--workspace") workspacePath = resolve(value);
      if (arg === "--include-untracked") untracked.push(value);
      if (arg === "--input-artifact") inputArtifactId = value;
      if (arg === "--depends-on") dependsOn.push(value);
      if (arg === "--accept") acceptance.push(value);
      if (arg === "--revision") {
        revision = Number(value);
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw new Error("--revision requires a positive integer");
      }
      continue;
    }
    throw new Error(`Unknown option ${arg} for ${verb}`);
  }
  if (help) return { help: true, state };
  const common: Common = {
    state,
    help: false,
    ...(socketPath ? { socketPath } : {}),
    ...(commandId ? { commandId } : {}),
  };
  if (verb === "run") {
    if (socketPath && !agent && !seen.has("--cwd"))
      throw new Error("A solo run through --socket requires --cwd with the host's working directory");
    if (repos.length && !agent) throw new Error("--repo requires --agent");
    if (agent && model) throw new Error("Declared agents select their model in Nix");
    model ??= agent ? undefined : environment.DURA_MODEL;
    if (model && !/^[^/\s]+\/[^\s]+$/.test(model)) throw new Error("--model requires PROVIDER/MODEL");
    if (workspacePath && !agent) throw new Error("--workspace requires --agent");
    if (untracked.length && !workspacePath) throw new Error("--include-untracked requires --workspace");
    if (workspacePath && seen.has("--cwd") && cwd !== workspacePath)
      throw new Error("--workspace and --cwd must identify the same directory");
    if (watch && detach) throw new Error("--watch requires an attached frontend; omit --detach");
    return {
      ...common,
      verb,
      name,
      cwd: workspacePath ?? cwd,
      prompt: words.join(" ") || undefined,
      detach,
      watch,
      agent,
      model,
      repos,
      catalogFile,
      ...(workspacePath ? { workspace: { includeUntracked: untracked } } : {}),
    };
  }
  if (verb === "runs" || verb === "agents" || verb === "serve" || verb === "socket") {
    if (words.length) throw new Error(`${verb} does not take a run name`);
    if (verb === "agents") return { ...common, verb, json, catalogFile };
    if (verb === "serve") return { ...common, verb, catalogFile };
    if (verb === "runs") return { ...common, verb, json };
    return { ...common, verb: "socket" };
  }
  const target = words[0];
  if (verb === "answer") {
    if (!target || words.length < 2) throw new Error("answer requires a question ID and answer text");
    return { ...common, verb, questionId: target, answer: words.slice(1).join(" ") };
  }
  if (verb === "retry" || verb === "revise" || verb === "integrate") {
    if (!target || (verb !== "revise" && words.length !== 1))
      throw new Error(`${verb} requires exactly one task ID`);
    if (revision === undefined) throw new Error(`${verb} requires --revision from the current task`);
    if (verb === "revise") {
      if (
        (seen.has("--clear-dependencies") && dependsOn.length) ||
        (seen.has("--clear-acceptance") && acceptance.length)
      )
        throw new Error("Choose a replacement list or its clearing flag, not both");
      const objective = words.slice(1).join(" ");
      const input: ReviseTaskInput = {
        ...(objective ? { objective } : {}),
        ...(inputArtifactId ? { inputArtifactId } : {}),
        ...(seen.has("--depends-on") || seen.has("--clear-dependencies") ? { dependsOn } : {}),
        ...(seen.has("--accept") || seen.has("--clear-acceptance") ? { acceptance } : {}),
      };
      if (!Object.keys(input).length)
        throw new Error("revise requires an objective or an input/acceptance change");
      return { ...common, verb, taskId: target, revision, input };
    }
    return { ...common, verb, taskId: target, revision };
  }
  if (words.length !== 1 || !target) throw new Error(`${verb} requires exactly one run name or ID`);
  if (verb === "attach") return { ...common, verb, name: target, json, watch, ...(taskId ? { taskId } : {}) };
  return { ...common, verb, name: target, json };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = parseCommand(isVerb(args[0]) ? args : ["run", ...args]);
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
  if (command.verb === "socket") {
    process.stdout.write(`${command.socketPath ?? runtimeSocket(command.state)}\n`);
    return;
  }
  const runtime = new Runtime({
    stateDirectory: command.state,
    socketPath: command.socketPath,
  });
  await ensureLocalRuntime(runtime, {
    stateDirectory: command.state,
    socketPath: command.socketPath,
    catalogFile: command.verb === "run" ? command.catalogFile : undefined,
  });
  const commandId = MUTATIONS.includes(command.verb) ? (command.commandId ?? randomUUID()) : undefined;
  try {
    if (command.verb === "run") {
      const run = await runtime.start(
        {
          name: command.name,
          cwd: command.cwd,
          prompt: command.prompt,
          agent: command.agent,
          model: command.model,
          repos: command.repos,
          workspace: command.workspace,
        },
        commandId,
        command.catalogFile,
      );
      if (command.detach) process.stdout.write(`${run.name}\n`);
      else
        await attach(run, command.state, undefined, command.watch, command.socketPath, !!command.socketPath);
    } else if (command.verb === "attach") {
      const detail = await runtime.inspect(command.name);
      await attach(
        detail.run,
        command.state,
        command.taskId,
        command.watch,
        command.socketPath,
        !!command.socketPath,
      );
    } else if (command.verb === "answer") {
      const answer = await runtime.answer(command.questionId, command.answer, commandId);
      process.stdout.write(`Answered ${answer.id}.\n`);
    } else if (command.verb === "retry") {
      const task = await runtime.retry(command.taskId, command.revision, commandId);
      process.stdout.write(
        `Queued task ${task.id} revision ${task.revision}, attempt ${task.currentAttemptId}.\n`,
      );
    } else if (command.verb === "revise") {
      const task = await runtime.revise(command.taskId, command.revision, command.input, commandId);
      process.stdout.write(`Revised task ${task.id} to revision ${task.revision}.\n`);
    } else if (command.verb === "integrate") {
      const integration = await runtime.integrate(command.taskId, command.revision, commandId);
      process.stdout.write(`Queued integration ${integration.id}.\n`);
    } else if (command.verb === "apply") {
      const result = await runtime.apply(command.name, commandId);
      process.stdout.write(
        command.json
          ? `${JSON.stringify(result)}\n`
          : `${result.applied ? "Applied" : "Already applied"} artifact ${result.artifactId}.\n`,
      );
    } else if (command.verb === "runs") {
      const runs = await Promise.all((await runtime.list()).map((run) => runtime.inspect(run.id)));
      if (command.json) process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
      else if (!runs.length) process.stdout.write("No managed runs. Start one with dura run.\n");
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
            `${task.id}  ${task.role ?? "solo"}  revision ${task.revision}  ${task.status} / ${attempt?.status ?? "unknown"}\n`,
          );
          if (attempt?.error) process.stdout.write(`  Attention: ${plain(attempt.error)}\n`);
          if (task.waitFor.length)
            process.stdout.write(`  Waiting for: ${task.waitFor.map(plain).join(", ")}\n`);
          if (task.report)
            process.stdout.write(
              `  Report (unverified, SHA-256 ${task.report.digest}):\n${plain(task.report.text)
                .split("\n")
                .map((line) => `    ${line}`)
                .join("\n")}\n`,
            );
          if (task.artifactId) process.stdout.write(`  Artifact: ${task.artifactId}\n`);
        }
        for (const question of detail.questions.filter((question) => question.status === "open"))
          process.stdout.write(`Question ${question.id}: ${plain(question.question)}\n`);
        for (const integration of detail.integrations.filter(
          (integration) => integration.status === "conflicted",
        ))
          process.stdout.write(
            `Conflict ${integration.id}: ${integration.conflicts.map(plain).join(", ")}\n`,
          );
        for (const integration of detail.integrations.filter(
          (integration) => integration.status === "failed",
        ))
          process.stdout.write(
            `Integration ${integration.id} failed: ${plain(integration.error ?? "No diagnostic was recorded")}\n`,
          );
        for (const verification of detail.verifications.filter(
          (verification) => verification.status === "failed" || verification.error,
        )) {
          process.stdout.write(
            `Verification ${verification.id} ${verification.status} for tree ${verification.tree}.\n`,
          );
          if (verification.error) process.stdout.write(`  Attention: ${plain(verification.error)}\n`);
        }
        if (run.acceptedArtifactId) process.stdout.write(`Accepted artifact: ${run.acceptedArtifactId}\n`);
        process.stdout.write(`History: ${detail.events.length} recorded transitions\n`);
      }
    } else if (command.verb === "recover") {
      const run = await runtime.recover(command.name, commandId);
      process.stdout.write(`Recovered ${run.name}.\n`);
    } else if (command.verb === "stop") {
      const run = await runtime.stop(command.name, commandId);
      process.stdout.write(`Stopping ${run.name}. Conversations and workspaces are retained.\n`);
    }
  } catch (error) {
    if (commandId)
      process.stderr.write(
        `Command ID: ${commandId}. Reuse --command-id ${commandId} when retrying this invocation.\n`,
      );
    throw error;
  } finally {
    runtime.close();
  }
}

async function attach(
  run: Run,
  state: string,
  taskId?: string,
  watch = false,
  socketPath?: string,
  remote = false,
): Promise<void> {
  let cwd = process.cwd();
  if (!remote) {
    try {
      if (statSync(run.cwd).isDirectory()) cwd = run.cwd;
    } catch {}
  }
  const args = ["--dura", run.id, "--state", resolve(state)];
  if (taskId) args.push("--task", taskId);
  if (socketPath) args.push("--socket", socketPath);
  if (watch) args.push("--watch");
  process.exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(process.env.DURA_FRONTEND ?? "pituitary", args, {
      stdio: "inherit",
      cwd,
    });
    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        reject(
          new Error(
            `Pituitary is not installed. Run ${run.name} remains active; use pituitary --dura ${run.name} to attach.`,
          ),
        );
      else reject(error);
    });
    child.once("exit", (code, signal) => done(signal ? 1 : (code ?? 1)));
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`dura: ${plain(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
