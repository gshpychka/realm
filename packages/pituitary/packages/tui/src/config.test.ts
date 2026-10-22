import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachCommand, resolveAgentCommand, resumeArgs, resumeCommand } from "./config.ts";

let oldArgs: string | undefined;
let oldJson: string | undefined;
beforeEach(() => {
  oldArgs = process.env.PI_AGENT_ARGS;
  oldJson = process.env.PI_AGENT_ARGS_JSON;
  delete process.env.PI_AGENT_ARGS;
  delete process.env.PI_AGENT_ARGS_JSON;
});
afterEach(() => {
  if (oldArgs === undefined) delete process.env.PI_AGENT_ARGS;
  else process.env.PI_AGENT_ARGS = oldArgs;
  if (oldJson === undefined) delete process.env.PI_AGENT_ARGS_JSON;
  else process.env.PI_AGENT_ARGS_JSON = oldJson;
});

test("managed reconnect commands preserve run identity and custom state with shell quoting", () => {
  expect(attachCommand("builder", "/tmp/my 'private' state")).toBe(
    "pituitary attach builder --state '/tmp/my '\\''private'\\'' state'",
  );
  expect(attachCommand("builder")).toBe("pituitary attach builder");
});

describe("resumeArgs", () => {
  test("carries on in the session file, dropping what chose the first session", () => {
    expect(
      resumeArgs(
        ["--no-extensions", "-e", "x.ts", "--continue", "--model", "sonnet", "--thinking", "high"],
        "/s.jsonl",
      ),
    ).toEqual(["--no-extensions", "-e", "x.ts", "--session", "/s.jsonl"]);
    expect(resumeArgs(["--session", "/old.jsonl", "--fork", "abc"], "/new.jsonl")).toEqual([
      "--session",
      "/new.jsonl",
    ]);
  });

  test("keeps the flags alone when there is no session file", () => {
    expect(resumeArgs(["--no-session", "--tools", "read"], undefined)).toEqual([
      "--no-session",
      "--tools",
      "read",
    ]);
  });

  test("drops session overrides using equals syntax without losing the following flag", () => {
    expect(resumeArgs(["--model=sonnet", "--session=/old file", "--no-extensions"], "/new file")).toEqual([
      "--no-extensions",
      "--session",
      "/new file",
    ]);
  });
});

test("resume commands quote shell syntax in session paths", () => {
  expect(resumeCommand("/tmp/session.jsonl")).toBe("pituitary --session /tmp/session.jsonl");
  expect(resumeCommand("/tmp/a user's $session.jsonl")).toBe(
    "pituitary --session '/tmp/a user'\\''s $session.jsonl'",
  );
});

describe("resolveAgentCommand", () => {
  test("structured arguments preserve spaces and take precedence over legacy arguments", () => {
    process.env.PI_AGENT_ARGS = "--name wrong";
    process.env.PI_AGENT_ARGS_JSON = JSON.stringify(["--session-dir", "/some directory/sessions"]);
    expect(resolveAgentCommand(["--continue"]).args).toEqual([
      "--session-dir",
      "/some directory/sessions",
      "--continue",
    ]);
  });

  test("direct commands retain the configured executable's arguments", () => {
    process.env.PI_AGENT_ARGS_JSON = JSON.stringify(["/script with spaces.ts"]);
    expect(resolveAgentCommand(["--version"]).args).toEqual(["/script with spaces.ts", "--version"]);
  });

  test("an explicitly requested output mode runs in pi without being overridden by the frontend", () => {
    for (const mode of ["text", "json", "rpc"]) {
      expect(resolveAgentCommand(["--mode", mode, "the prompt"])).toMatchObject({
        direct: true,
        args: ["--mode", mode, "the prompt"],
        prompt: null,
      });
    }
  });

  test("rejects malformed structured arguments before starting the UI", () => {
    for (const value of ["oops", "{}", '["ok",2]']) {
      process.env.PI_AGENT_ARGS_JSON = value;
      expect(() => resolveAgentCommand([])).toThrow("JSON array of strings");
    }
  });
  test("passes pi's own flags through, values included", () => {
    expect(resolveAgentCommand(["--continue", "--model", "sonnet", "--no-extensions"])).toMatchObject({
      args: ["--continue", "--model", "sonnet", "--no-extensions"],
      prompt: null,
      resume: false,
    });
  });

  test("keeps --resume for the client's own picker", () => {
    const resolved = resolveAgentCommand(["-r", "--model", "x"]);
    expect(resolved.resume).toBe(true);
    expect(resolved.args).toEqual(["--model", "x"]);
  });

  test("turns words that are not flag values into the first prompt", () => {
    expect(resolveAgentCommand(["--thinking", "high", "fix", "the", "limits"]).prompt).toBe("fix the limits");
    expect(resolveAgentCommand(["--", "-not-a-flag"]).prompt).toBe("-not-a-flag");
  });

  test("leaves help, version, print, and export to pi itself", () => {
    expect(resolveAgentCommand(["--help"]).direct).toBe(true);
    expect(resolveAgentCommand(["-p", "hello"]).direct).toBe(true);
  });
});
