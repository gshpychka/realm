import { expect, test } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { editExternally } from "./external-editor.ts";

test("an editor removing its scratch file returns a failure and resumes the UI", () => {
  const before = process.env.PITUITARY_EDITOR;
  const calls: string[] = [];
  const renderer = {
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
  } as unknown as CliRenderer;
  process.env.PITUITARY_EDITOR = "rm";
  try {
    expect(editExternally(renderer, "keep this draft")).toBeNull();
    expect(calls).toEqual(["suspend", "resume"]);
  } finally {
    if (before === undefined) delete process.env.PITUITARY_EDITOR;
    else process.env.PITUITARY_EDITOR = before;
  }
});
