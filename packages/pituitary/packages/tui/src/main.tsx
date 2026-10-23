#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { useEffect, useState } from "react";
import { App } from "./app.tsx";
import { duraOptions, type PiCommand, piCommand, resumePiArgs } from "./cli.ts";
import type { Command } from "./commands/commands.ts";
import { OptInText } from "./components/text.ts";
import { openLog } from "./config.ts";
import { loadPiKeymap } from "./keymap.ts";
import { prewarm } from "./nvim/engine.ts";
import { PiConversation } from "./pi.ts";
import { mark } from "./profile.ts";
import { RELOAD_UI } from "./ui-state.ts";

mark("modules");
const argv = process.argv.slice(2);
try {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `Pituitary — your terminal frontend for Pi and Dura\n\n  pituitary [Pi options] [task]\n  pituitary --dura RUN --state DIRECTORY [--task TASK] [--socket PATH] [--watch]\n\nPlain Pituitary uses your Pi settings, extensions, sessions and /login.\nDura connects to a durable team; closing the frontend leaves its work running.\n\nPi options:\n`,
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
  const start = (args: readonly string[]) =>
    new PiConversation({
      command: agent.command,
      args,
      onStderr: (text) => log.write(text),
    });
  let client = start(agent.args);
  mark("agent-spawned");
  prewarm();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 120, maxFps: 120 });
  mark("renderer");
  extend({ text: OptInText });
  let root = createRoot(renderer);
  renderer.once("frame", () => mark("first-frame"));
  let quitting = false;
  let handoffActive = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    mark("quit");
    const sessionFile = client.sessionFile;
    const closing = client.close();
    root.unmount();
    mark("ui-unmounted");
    renderer.destroy();
    mark("renderer-destroyed");
    await closing;
    mark("agent-closed");
    if (sessionFile) process.stdout.write(`Resume: pituitary --session ${JSON.stringify(sessionFile)}\n`);
    process.exit(0);
  };
  function Workspace({ initialPrompt }: { initialPrompt?: string }) {
    const [commands, setCommands] = useState<Command[]>([]);
    useEffect(() => {
      let active = true;
      // Pi supplies its loaded extension, prompt and skill commands.
      void client
        .request({ type: "get_commands" })
        .then((value) => {
          const result = value as {
            commands: Array<{ name: string; description?: string; source: "extension" | "prompt" | "skill" }>;
          };
          if (active)
            setCommands(
              result.commands.map((command) => ({
                name: command.name,
                description: command.description ?? "",
                source: command.source === "skill" ? "prompt" : command.source,
              })),
            );
        })
        .catch((error) => log.write(`loading Pi commands: ${String(error)}\n`));
      return () => {
        active = false;
      };
    }, []);
    return (
      <App
        link={client}
        extensionUI={client}
        commands={commands}
        initialPrompt={initialPrompt}
        keys={loadPiKeymap()}
        onQuit={() => void quit()}
        onHandoff={(command) => void handoff(command)}
        onNewSession={async () => {
          const result = (await client.request({ type: "new_session" })) as { cancelled: boolean };
          if (result.cancelled) return;
          root.unmount();
          root = createRoot(renderer);
          render();
        }}
      />
    );
  }
  const render = (initialPrompt?: string) => root.render(<Workspace initialPrompt={initialPrompt} />);
  const handoff = async (command: string) => {
    if (handoffActive || quitting) return;
    handoffActive = true;
    const state = await client.getState().catch(() => undefined);
    root.unmount();
    renderer.suspend();
    await client.close();
    const scratch = mkdtempSync(join(tmpdir(), "pituitary-handoff-"));
    const result = join(scratch, "session");
    const carried = state?.sessionFile && existsSync(state.sessionFile) ? state.sessionFile : undefined;
    let selected = carried;
    try {
      const extension = fileURLToPath(new URL("./pi-handoff.ts", import.meta.url));
      spawnSync(agent.command, [...resumePiArgs(agent.args, carried), "--extension", extension], {
        stdio: "inherit",
        env: { ...process.env, PITUITARY_HANDOFF: command, PITUITARY_HANDOFF_RESULT: result },
      });
      if (existsSync(result)) selected = readFileSync(result, "utf8").trim() || carried;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      client = start(resumePiArgs(agent.args, selected));
      renderer.resume();
      handoffActive = false;
      root = createRoot(renderer);
      render();
    }
  };
  process.once("SIGTERM", () => void quit());
  process.once("SIGHUP", () => void quit());
  process.once("exit", () => mark("exit"));
  render(agent.prompt);
  if (agent.resume) void handoff("/resume");
}

/** Reload only the disposable frontend process, retaining its draft and Dura's live work. */
async function superviseDura(): Promise<void> {
  const scratch = process.env.PITUITARY_UI_STATE ? undefined : mkdtempSync(join(tmpdir(), "pituitary-ui-"));
  const state = process.env.PITUITARY_UI_STATE ?? join(scratch as string, "view.json");
  let resume = process.env.PITUITARY_UI_RESUME === "1";
  try {
    for (;;) {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...argv], {
        stdio: "inherit",
        env: {
          ...process.env,
          PITUITARY_FRONTEND_CHILD: "1",
          PITUITARY_UI_STATE: state,
          PITUITARY_UI_RESUME: resume ? "1" : "0",
        },
      });
      const stop = () => {
        child.kill("SIGTERM");
      };
      process.once("SIGTERM", stop);
      process.once("SIGHUP", stop);
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
      }).finally(() => {
        process.off("SIGTERM", stop);
        process.off("SIGHUP", stop);
      });
      if (code !== RELOAD_UI) {
        process.exitCode = code;
        return;
      }
      resume = true;
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
