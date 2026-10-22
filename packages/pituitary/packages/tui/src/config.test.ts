import { describe, expect, test } from "bun:test";
import { resolveAgentCommand, resumeArgs } from "./config.ts";

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
});

describe("resolveAgentCommand", () => {
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
