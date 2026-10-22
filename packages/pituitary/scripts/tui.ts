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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { type Command, SOCKET } from "./drive.ts";

const VALUED = new Set(["pi", "env", "scenario", "delay", "cols", "rows", "entry", "ready", "timeout"]);

function parse(argv: string[]): Command {
  const [op = "screen", ...rest] = argv;
  const args: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index] ?? "";
    if (!word.startsWith("--")) {
      args.push(word);
      continue;
    }
    const next = rest[index + 1];
    // These always take a value, which may itself start with dashes, as pi's own flags do.
    const valued = VALUED.has(word.slice(2));
    if (next === undefined || (!valued && next.startsWith("--"))) options[word.slice(2)] = "";
    else {
      options[word.slice(2)] = next;
      index++;
    }
  }
  return { op, args, options };
}

/** True when a driver answers on the socket; a socket left by a dead driver is removed. */
async function answering(): Promise<boolean> {
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
  if (await answering()) return;
  mkdirSync(dirname(SOCKET), { recursive: true });
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
    const socket = connect(SOCKET);
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

const command = parse(process.argv.slice(2));
// A fresh driver per session, so it runs the harness as it is on disk now.
if (command.op === "start" && (await answering())) {
  await send({ op: "stop", args: [], options: {} });
  for (let attempt = 0; attempt < 100 && existsSync(SOCKET); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
if (command.op !== "stop" || (await answering())) {
  await ensureDriver();
  const { ok, output } = await send(command);
  process.stdout.write(`${output}\n`);
  process.exit(ok ? 0 : 1);
}
