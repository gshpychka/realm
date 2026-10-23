import { expect, test } from "bun:test";
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
  expect(parseCommand(["attach", "builder", "--task", "child-task"], {})).toMatchObject({
    verb: "attach",
    name: "builder",
    taskId: "child-task",
  });
  expect(parseCommand(["serve", "--state", "/tmp/runtime"], {})).toMatchObject({
    verb: "serve",
    state: "/tmp/runtime",
  });
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

test("workspace capture and UI iteration options express one isolated input", () => {
  expect(
    parseCommand(
      ["run", "--agent", "builder", "--workspace", "/tmp/source", "--include-untracked", "new.ts", "--watch"],
      {},
    ),
  ).toMatchObject({ cwd: "/tmp/source", workspace: { includeUntracked: ["new.ts"] }, watch: true });
  expect(() => parseCommand(["run", "--workspace", "/tmp/source"], {})).toThrow("--agent");
  expect(() => parseCommand(["run", "--include-untracked", "new.ts"], {})).toThrow("--workspace");
  expect(() =>
    parseCommand(["run", "--agent", "builder", "--workspace", "/tmp/source", "--cwd", "/tmp/other"], {}),
  ).toThrow("same directory");
  expect(() => parseCommand(["run", "--watch", "--detach"], {})).toThrow("attached frontend");
  expect(parseCommand(["attach", "review", "--socket", "/tmp/tunnel.sock", "--watch"], {})).toMatchObject({
    socketPath: "/tmp/tunnel.sock",
    watch: true,
  });
});

test("operator edits carry the expected current revision", () => {
  expect(parseCommand(["retry", "task-1", "--revision", "3"], {})).toMatchObject({
    taskId: "task-1",
    revision: 3,
  });
  expect(() => parseCommand(["retry", "task-1"], {})).toThrow("--revision");
  expect(
    parseCommand(
      [
        "revise",
        "task-1",
        "--revision",
        "3",
        "--accept",
        "Preserve the index",
        "--depends-on",
        "task-2",
        "Improve",
        "the result",
      ],
      {},
    ),
  ).toMatchObject({
    input: { objective: "Improve the result", acceptance: ["Preserve the index"], dependsOn: ["task-2"] },
  });
  expect(parseCommand(["answer", "question-1", "Use", "the", "existing", "menu"], {})).toMatchObject({
    questionId: "question-1",
    answer: "Use the existing menu",
  });
});
