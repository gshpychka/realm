#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app.tsx";
import { duraOptions, type PiCommand, piCommand, resumePiArgs } from "./cli.ts";
import { openLog } from "./config.ts";
import { loadPiKeymap } from "./keymap.ts";
import { prewarm } from "./nvim/engine.ts";
import { type PiControls, PiConversation } from "./pi.ts";
import { extensionArgs, HANDOFF_EXTENSION, PI_EXTENSIONS } from "./pi-extensions.ts";
import { mark } from "./profile.ts";
import { RELOAD_UI } from "./ui-state.ts";

/**
 * Erases the screen and puts the cursor at its top left. Pi's own screen switches to an
 * alternate screen and back as it starts, so an alternate screen around it would not hold it.
 */
const CLEAR_SCREEN = "\x1b[2J\x1b[H";

mark("modules");
const argv = process.argv.slice(2);
try {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `Pituitary — your terminal frontend for Pi and Dura\n\n  pituitary [Pi options] [task]\n  pituitary --dura RUN [--state DIRECTORY] [--task TASK] [--socket PATH] [--watch]\n\nPlain Pituitary uses your Pi settings, extensions, sessions and /login.\nDura connects to a durable team; closing the frontend leaves its work running.\nDura state: --state DIRECTORY, then DURA_STATE_DIR, then $XDG_STATE_HOME/dura\n(or ~/.local/state/dura when XDG_STATE_HOME is unset).\nDura socket: --socket PATH or DURA_RUNTIME_SOCKET; otherwise use the local state socket.\n\nPi options:\n`,
    );
    const command = piCommand(["--help"]);
    process.exit(spawnSync(command.command, command.args, { stdio: "inherit" }).status ?? 1);
  }
  const managed = duraOptions(argv);
  if (managed) {
    if (process.env.PITUITARY_FRONTEND_CHILD === "1") {
      const { runDura } = await import("./dura.tsx");
      await runDura(managed);
    } else {
      await superviseDura();
    }
  } else {
    await runPi(piCommand(argv));
  }
} catch (error) {
  process.stderr.write(`pituitary: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

async function runPi(agent: PiCommand): Promise<void> {
  if (agent.direct) {
    process.exit(spawnSync(agent.command, agent.args, { stdio: "inherit" }).status ?? 1);
  }
  const log = openLog();
  process.on("unhandledRejection", (reason) => log.write(`unhandled rejection: ${String(reason)}\n`));
  const client = new PiConversation({
    command: agent.command,
    args: [...agent.args, ...extensionArgs()],
    bridge: PI_EXTENSIONS.bridge,
    log: (text) => log.write(text),
  });
  mark("agent-spawned");
  prewarm();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 120, maxFps: 120 });
  mark("renderer");
  const root = createRoot(renderer);
  renderer.once("frame", () => mark("first-frame"));
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    mark("quit");
    const { sessionId, sessionFile } = client;
    const { cwd } = client.workspace();
    const closing = client.close();
    root.unmount();
    mark("ui-unmounted");
    renderer.destroy();
    mark("renderer-destroyed");
    await closing;
    mark("agent-closed");
    // Pi writes a session's file with its first message; until then there is nothing to resume.
    if (sessionId && sessionFile && existsSync(sessionFile))
      process.stdout.write(
        `Resume: ${cwd === process.cwd() ? "" : `cd ${shellWord(cwd)} && `}pituitary --session ${sessionId}\n`,
      );
    process.exit(0);
  };
  /** Pi's own screen on the current session, then Pi over RPC again on the session it ends on. */
  const handoff = async (command: string) => {
    const state = await client.getState().catch(() => undefined);
    await client.suspend();
    const scratch = mkdtempSync(join(tmpdir(), "pituitary-handoff-"));
    const result = join(scratch, "session");
    const saved = (file?: string) => (file && existsSync(file) ? file : undefined);
    const carried = saved(state?.sessionFile);
    let selected = carried;
    try {
      try {
        spawnSync(agent.command, [...resumePiArgs(agent.args, carried), "--extension", HANDOFF_EXTENSION], {
          stdio: "inherit",
          cwd: client.workspace().cwd,
          env: { ...process.env, PITUITARY_HANDOFF: command, PITUITARY_HANDOFF_RESULT: result },
        });
      } finally {
        // Pi draws its screen inline and prints its own resume line as it exits. The screen is
        // cleared, at once, so the instructions Pituitary prints when it closes are not read
        // alongside Pi's.
        writeSync(process.stdout.fd, CLEAR_SCREEN);
      }
      if (existsSync(result)) selected = saved(readFileSync(result, "utf8").trim()) ?? carried;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await client.resume([...resumePiArgs(agent.args, selected), ...extensionArgs()]);
    }
  };
  const pi: PiControls = {
    conversation: client,
    handoff,
    resumeAtStart: agent.resume,
    keymap: () => loadPiKeymap(),
  };
  process.once("SIGTERM", () => void quit());
  process.once("SIGHUP", () => void quit());
  process.once("exit", () => mark("exit"));
  root.render(<App link={client} pi={pi} initialPrompt={agent.prompt} onQuit={() => void quit()} />);
}

/** `word` as one shell word. */
function shellWord(word: string): string {
  return /^[\w./~@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** Reload only the disposable frontend process, retaining its draft and Dura's live work. */
async function superviseDura(): Promise<void> {
  const scratch = process.env.PITUITARY_UI_STATE ? undefined : mkdtempSync(join(tmpdir(), "pituitary-ui-"));
  const state = process.env.PITUITARY_UI_STATE ?? join(scratch as string, "view.json");
  let resume = process.env.PITUITARY_UI_RESUME === "1";
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    for (;;) {
      child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...argv], {
        stdio: "inherit",
        env: {
          ...process.env,
          PITUITARY_FRONTEND_CHILD: "1",
          PITUITARY_UI_STATE: state,
          PITUITARY_UI_RESUME: resume ? "1" : "0",
        },
      });
      const code = await new Promise<number>((resolve, reject) => {
        child?.once("error", reject);
        child?.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
      });
      if (stopping || code !== RELOAD_UI) {
        process.exitCode = code;
        return;
      }
      resume = true;
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
