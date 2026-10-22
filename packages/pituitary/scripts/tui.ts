/**
 * Operates the live UI session that `scripts/drive.ts` holds, starting it if needed.
 *
 *   just tui start [--scenario tool] [--delay 40] [--pi "--no-session -e x.ts"] [--env "K=v;K2=v2"]
 *                  [--entry path --ready text]
 *   just tui submit "what is here"      just tui type "text"      just tui key esc down enter ctrl+c
 *   just tui wait "Three entries"       just tui screen [--style] just tui capture name
 *   just tui resize 120 40              just tui stop
 *
 * TUI_SESSION=name keeps a separate session, for driving several at once.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { type Command, driverSocket, HELP, parseCommand, prepareDriverSocket } from "./tui-command.ts";

/** True when a driver answers on the socket; a socket left by a dead driver is removed. */
async function answering(): Promise<boolean> {
  const SOCKET = driverSocket();
  if (!existsSync(SOCKET)) return false;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect(SOCKET);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
  if (!alive) rmSync(SOCKET, { force: true });
  return alive;
}

async function ensureDriver(): Promise<void> {
  const SOCKET = driverSocket();
  if (await answering()) return;
  const driver = spawn(process.execPath, [join(import.meta.dirname, "drive.ts")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  driver.unref();
  for (let attempt = 0; attempt < 100 && !existsSync(SOCKET); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(SOCKET)) throw new Error("the driver did not start");
}

async function send(command: Command): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(driverSocket());
    let reply = "";
    socket.on("data", (chunk) => {
      reply += chunk.toString();
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(reply));
      } catch (cause) {
        reject(new Error(`the driver answered ${JSON.stringify(reply)}`, { cause }));
      }
    });
    socket.on("error", reject);
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.op === "help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  prepareDriverSocket();
  // A fresh driver per session, so it runs the harness as it is on disk now.
  if (command.op === "start" && (await answering())) {
    await send({ op: "stop", args: [], options: {} });
    for (let attempt = 0; attempt < 100 && existsSync(driverSocket()); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (command.op === "start") await ensureDriver();
  else if (!(await answering())) {
    if (command.op === "stop") {
      process.stdout.write("stopped\n");
      process.exit(0);
    }
    throw new Error("no session; run 'just tui start' first");
  }
  const { ok, output } = await send(command);
  process.stdout.write(`${output}\n`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
