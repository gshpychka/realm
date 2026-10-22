#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { Runtime } from "@pituitary/harness/runtime";
import { connectWorker } from "@pituitary/harness/worker-client";
import {
  type AgentLink,
  BRIDGE_EXTENSION,
  BridgeHost,
  HANDOFF_ENV,
  HANDOFF_RESULT_ENV,
  PiRpcClient,
} from "@pituitary/rpc";
import { App, type AppProps } from "./app.tsx";
import { OptInText } from "./components/text.ts";
import { attachCommand, openLog, resolveAgentCommand, resumeArgs, resumeCommand } from "./config.ts";
import { prewarm } from "./nvim/engine.ts";
import { mark } from "./profile.ts";

mark("modules");

const log = openLog();
const agent = resolveAgentCommand();
const workerSocket = process.env.PITUITARY_WORKER_SOCKET;
const managedRun = process.env.PITUITARY_RUN_ID;
const managed = Boolean(workerSocket || managedRun);

if (agent.direct) {
  const run = spawnSync(agent.command, agent.args, { stdio: "inherit" });
  process.exit(run.status ?? 1);
}

// A rejection nobody handled belongs in the log; on screen it would cover the UI.
process.on("unhandledRejection", (reason) => log.write(`unhandled rejection: ${String(reason)}\n`));

const bridge = managed ? undefined : new BridgeHost();
bridge?.onConnect(() => mark("bridge-connected"));
// Anthropic has not published these headers, so the log keeps the names and values seen,
// whenever the set of names changes.
let limitNames = "";
bridge?.onLimits((_limits, headers) => {
  const names = Object.keys(headers).sort().join(",");
  if (names === limitNames) return;
  limitNames = names;
  log.write(`usage-limit headers: ${JSON.stringify(headers)}\n`);
});
// The socket directory goes with the process however it ends.
process.on("exit", () => {
  bridge?.close();
  mark("exit");
});
const withBridge = (args: readonly string[]) => [...args, "--extension", BRIDGE_EXTENSION];

function startAgent(args: readonly string[]): PiRpcClient {
  const started = new PiRpcClient({
    command: agent.command,
    args: withBridge(args),
    env: bridge?.env(),
    onStderr: (chunk) => log.write(chunk),
    onExit: (code, signal) => log.write(`agent exited code=${code} signal=${signal}\n`),
  });
  started.start();
  return started;
}

let client: AgentLink;
let workspace: AppProps["workspace"];
let archived = false;
if (managedRun) {
  const runtime = new Runtime({ stateDirectory: process.env.PITUITARY_STATE_DIR as string });
  try {
    const detail = await runtime.inspect(managedRun);
    const task = detail.tasks.find(
      (item) => item.id === (process.env.PITUITARY_TASK_ID ?? detail.run.rootTaskId),
    );
    if (!task) throw new Error("No such task in this run");
    const attempt = detail.attempts.find((item) => item.id === task.currentAttemptId);
    if (!attempt) throw new Error("Task has no current attempt");
    const attached = await runtime.attach(detail.run.id, task.id);
    client = attached;
    archived = attached.identity.archived === true;
    workspace = {
      cwd: attached.identity.cwd,
      local: attempt.execution.kind === "local" && !archived,
      readonly: archived,
      label: [task.role, archived ? "archived" : undefined].filter(Boolean).join(" · ") || undefined,
    };
  } finally {
    runtime.close();
  }
} else if (workerSocket) {
  const attached = await connectWorker(workerSocket);
  client = attached;
  workspace = { cwd: attached.identity.cwd, local: true };
} else {
  client = startAgent(agent.args);
}
mark("agent-spawned");
prewarm();

/** Frames match a 120 Hz display. */
const FPS = 120;

// Ctrl+C reaches the app so it can shut the agent down before the renderer stops.
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: FPS, maxFps: FPS });
mark("renderer");
// OpenTUI draws links for a terminal whose reply to its queries names one that supports them, or
// that sets COLORTERM to truecolor.
let terminalSeen = "";
renderer.on("capabilities", (caps: { hyperlinks?: boolean; terminal?: { name?: string } }) => {
  const seen = `terminal: ${caps.terminal?.name || "unnamed"} hyperlinks=${caps.hyperlinks === true}`;
  if (seen !== terminalSeen) log.write(`${seen}\n`);
  terminalSeen = seen;
});
extend({ text: OptInText });
const root = createRoot(renderer);
renderer.once("frame", () => mark("first-frame"));

let quitting = false;
let sessionFile: string | undefined;
const quit = () => {
  if (quitting) return;
  quitting = true;
  mark("quit");
  const closing = client.close();
  // Unmounting runs the components' cleanups, which stop nvim and the animation timers.
  root.unmount();
  mark("ui-unmounted");
  // The terminal comes back while pi shuts down.
  renderer.destroy();
  mark("renderer-destroyed");
  void closing.then(() => {
    mark("agent-closed");
    bridge?.close();
    mark("bridge-closed");
    if (managed) {
      const name = process.env.PITUITARY_RUN_NAME;
      process.stdout.write(
        name
          ? `Detached from run ${name}. To reconnect: ${attachCommand(name, process.env.PITUITARY_STATE_DIR, process.env.PITUITARY_TASK_ID)}\n`
          : "Detached from worker.\n",
      );
    } else if (sessionFile && existsSync(sessionFile))
      process.stdout.write(`To resume this session: ${resumeCommand(sessionFile)}\n`);
    process.exit(0);
  });
};

/**
 * Runs `text` in stock pi on the same session, then carries on in the session stock pi
 * ended on. The RPC agent stops first, so one pi at a time writes the session file.
 */
const handoff = async (text: string, sessionFile: string | undefined) => {
  // Each `root.render` mounts a tree of its own beside any already mounted.
  root.unmount();
  renderer.suspend();
  await client.close();
  const scratch = mkdtempSync(join(tmpdir(), "pituitary-handoff-"));
  const result = join(scratch, "session");
  // A session pi has not written yet has nothing to carry over, and stock pi starts afresh.
  const carried = sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
  process.stdout.write(`\npituitary hands ${text} to pi. Quit pi to come back.\n\n`);
  spawnSync(agent.command, withBridge(resumeArgs(agent.args, carried)), {
    stdio: "inherit",
    env: { ...process.env, [HANDOFF_ENV]: text, [HANDOFF_RESULT_ENV]: result },
  });
  let next = carried;
  try {
    next = readFileSync(result, "utf8").trim() || carried;
  } catch {
    // Stock pi that ended before its session started leaves the session as it was.
  }
  rmSync(scratch, { recursive: true, force: true });
  client = startAgent(resumeArgs(agent.args, next));
  renderer.resume();
  render();
};

/**
 * Starts the RPC agent afresh on the same session, for what pi reads only as it starts,
 * and shows `notice` once the new agent is up.
 */
const restart = async (notice: string, sessionFile: string | undefined) => {
  root.unmount();
  await client.close();
  if (quitting) return;
  const carried = sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
  client = startAgent(resumeArgs(agent.args, carried));
  render({ notice });
};

const render = (startWith: AppProps["startWith"] = {}) =>
  root.render(
    <App
      link={client}
      workspace={workspace}
      bridge={bridge}
      onQuit={quit}
      onSessionFile={(file) => {
        sessionFile = file;
      }}
      onHandoff={managed ? undefined : (text, sessionFile) => void handoff(text, sessionFile)}
      onRestart={managed ? undefined : (notice, sessionFile) => void restart(notice, sessionFile)}
      startWith={startWith}
    />,
  );

process.on("SIGTERM", () => quit());
process.on("SIGHUP", () => quit());
render({
  resume: agent.resume,
  prompt: agent.prompt,
  notice: archived
    ? "Archived conversation · read only. The conversation and workspace are retained."
    : undefined,
});
