import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand } from "./main.ts";

test("managed CLI accepts an objective and preserves literal leading dashes", () => {
  const command = parseCommand(["run", "--detach", "--name", "builder", "--", "--check", "this tree"], {});
  expect(command).toMatchObject({ verb: "run", name: "builder", detach: true, prompt: "--check this tree" });
});

test("help and argument failures happen before any runtime is created", () => {
  expect(parseCommand(["attach", "--help"], {}).help).toBe(true);
  expect(() => parseCommand(["attach"], {})).toThrow("exactly one");
  expect(() => parseCommand(["stop", "one", "two"], {})).toThrow("exactly one");
  expect(() => parseCommand(["run", "--name"], {})).toThrow("requires a value");
  expect(() => parseCommand(["run", "--detach", "--detach"], {})).toThrow("more than once");
  expect(() => parseCommand(["runs", "--detach"], {})).toThrow("Unknown option");
});

test("managed runtime state can be isolated without changing Pi state", () => {
  expect(parseCommand(["runs"], { PITUITARY_STATE_DIR: "/tmp/test-pituitary-runs" }).state).toBe(
    "/tmp/test-pituitary-runs",
  );
});

test("declared agents select a catalog and accept several pinned repositories", () => {
  expect(
    parseCommand(
      [
        "run",
        "--agent",
        "builder",
        "--repo",
        "owner/one@abc",
        "--repo",
        "owner/two@def",
        "--catalog",
        "/tmp/agents.json",
        "Build it",
      ],
      {},
    ),
  ).toMatchObject({
    verb: "run",
    agent: "builder",
    repos: ["owner/one@abc", "owner/two@def"],
    catalogFile: "/tmp/agents.json",
    prompt: "Build it",
  });
  expect(parseCommand(["agents", "--json"], {})).toMatchObject({ verb: "agents", json: true });
  expect(parseCommand(["recover", "builder"], {})).toMatchObject({ verb: "recover", name: "builder" });
  expect(() => parseCommand(["run", "--repo", "owner/repo"], {})).toThrow("requires --agent");
  expect(() => parseCommand(["agents", "builder"], {})).toThrow("does not take a run name");
});

test("named commands preserve their target while options appear on either side", () => {
  expect(parseCommand(["inspect", "--json", "review", "--state", "/tmp/review state"], {})).toEqual({
    verb: "inspect",
    name: "review",
    state: "/tmp/review state",
    json: true,
    help: false,
  });
  for (const verb of ["attach", "stop"]) {
    expect(parseCommand([verb, "review"], {})).toMatchObject({ verb, name: "review", help: false });
  }
});

test("options remain scoped to the command that supports them", () => {
  expect(() => parseCommand(["run", "--json"], {})).toThrow("Unknown option");
  expect(() => parseCommand(["attach", "review", "--name", "other"], {})).toThrow("Unknown option");
  expect(() => parseCommand(["stop", "review", "--cwd", "/tmp"], {})).toThrow("Unknown option");
  expect(() => parseCommand(["runs", "review"], {})).toThrow("does not take a run name");
});

test("the source CLI starts, inspects, and explicitly stops a persistent native run", () => {
  const root = mkdtempSync("/tmp/pituitary-cli-");
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
  const command = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args, "--state", root], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PITUITARY_AUTH_FILE: join(root, "credentials", "auth.json"),
        PITUITARY_CONFIG_DIRECTORY: join(root, "configuration"),
      },
    });
  try {
    const started = command("run", "--name", "persistent", "--detach", "--cwd", root);
    expect(started.status).toBe(0);
    expect(started.stdout.trim()).toBe("persistent");
    const listed = command("runs", "--json");
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([{ name: "persistent", status: "ready" }]);
    const inspected = command("inspect", "persistent", "--json");
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout).events.at(-1).type).toBe("worker_ready");
    const stopped = command("stop", "persistent");
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toContain("Stopped persistent");
  } finally {
    command("stop", "persistent");
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
