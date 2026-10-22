import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type RpcSessionState, stored } from "@pituitary/rpc";
import { sessionItems } from "./run-command.ts";

test("every directory includes sibling default session folders", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pituitary-sessions-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
  const store = (cwd: string, prompt: string, dir?: string) => {
    const manager = SessionManager.create(cwd, dir);
    const user = stored.user(prompt);
    const assistant = stored.assistant({ text: "a reply" });
    if (user.role !== "user" || assistant.role !== "assistant")
      throw new Error("incorrect stored message roles");
    manager.appendMessage(user);
    manager.appendMessage(assistant);
    return manager;
  };
  try {
    const current = store(join(scratch, "current"), "current project");
    const other = store(join(scratch, "other"), "another project");
    const file = current.getSessionFile();
    const otherFile = other.getSessionFile();
    if (!file || !otherFile) throw new Error("session was not persisted");
    const state = { sessionFile: file } as RpcSessionState;
    const listed = await sessionItems(state, dirname(file), true);
    expect(listed.map((item) => item.value).sort()).toEqual([file, otherFile].sort());

    const custom = store(join(scratch, "custom-project"), "custom project", join(scratch, "custom"));
    const customFile = custom.getSessionFile();
    if (!customFile) throw new Error("custom session was not persisted");
    const scoped = await sessionItems(
      { sessionFile: customFile } as RpcSessionState,
      dirname(customFile),
      true,
    );
    expect(scoped.map((item) => item.value)).toEqual([customFile]);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    rmSync(scratch, { recursive: true, force: true });
  }
});
