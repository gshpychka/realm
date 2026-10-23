import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { type Command, driverSocket } from "../scripts/tui-command.ts";
import { REPO } from "./helpers/harness.ts";

function cli(args: string[], name: string) {
  return spawnSync(process.execPath, [join(REPO, "scripts/tui.ts"), ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 45_000,
    env: { ...process.env, TUI_SESSION: name },
  });
}

test("development CLI rejects invalid input and prints help without starting a driver", () => {
  const name = `help-${process.pid}`;
  for (const args of [["help"], ["resize", "0", "20"], ["start", "--cols"], ["screen"]]) {
    const result = cli(args, name);
    assert.equal(result.status, args[0] === "help" ? 0 : 1, result.stderr);
    assert.doesNotMatch(result.stderr, /at .*\.(?:ts|js):\d/);
    assert.equal(existsSync(driverSocket(name)), false);
  }
});

function request(name: string, command: Command, extraChunk = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(driverSocket(name));
    let reply = "";
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(command)}\n`);
      if (extraChunk) setTimeout(() => socket.write("\n"), 30);
    });
    socket.on("data", (chunk) => {
      reply += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const parsed = JSON.parse(reply) as { ok: boolean; output: string };
        assert.ok(parsed.ok, parsed.output);
        resolve(parsed.output);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("development driver forwards entry environment and handles fragmented input once", async () => {
  // The longest accepted name must work even on Darwin's smaller sockaddr_un.
  const name = `driver-${process.pid}`.padEnd(40, "x");
  try {
    const started = cli(
      [
        "start",
        "--entry",
        "e2e/fixtures/development.ts",
        "--ready",
        "ready present",
        "--env",
        "PITUITARY_DRIVER_PROBE=present",
      ],
      name,
    );
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /ready present/);
    const result = await request(name, { op: "write", args: ["fragment"], options: {} }, true);
    assert.equal(result.match(/fragment/g)?.length, 1, result);
    const typed = cli(["type", "--", "--literal"], name);
    assert.equal(typed.status, 0, typed.stderr);
    assert.match(typed.stdout, /--literal/);
    const keyed = cli(["key", "space", "x"], name);
    assert.equal(keyed.status, 0, keyed.stderr);
    assert.match(keyed.stdout, /--literal x/);
  } finally {
    const stopped = cli(["stop"], name);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(driverSocket(name)), false);
  }
});
