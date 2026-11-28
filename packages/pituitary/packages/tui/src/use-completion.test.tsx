import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { createRef } from "react";
import type { Command } from "./commands/commands.ts";
import type { EditorHandle } from "./components/editor.tsx";
import { useCompletion } from "./use-completion.ts";

test("a completed frontend scan cannot offer files to a remote workspace", async () => {
  const directory = mkdtempSync("/tmp/pituitary-completion-");
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, "HOST_ONLY_SECRET.ts"), "operator file");
  const editor = createRef<EditorHandle>();
  let completion!: ReturnType<typeof useCompletion>;
  function Probe({ cwd }: { cwd: string | null }) {
    completion = useCompletion(editor, [], cwd);
    return null;
  }
  const app = await createTestRenderer({ width: 40, height: 8 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe cwd={directory} />));
    flushSync(() => completion.follow("@HOST_ONLY", 10));
    const deadline = Date.now() + 3000;
    while (!completion.completion) {
      if (Date.now() > deadline) throw new Error("file scan did not complete");
      await new Promise((resolve) => setTimeout(resolve, 1));
      await app.renderOnce();
    }
    expect(completion.completion.items[0]?.label).toBe("@HOST_ONLY_SECRET.ts");
    // The scan has demonstrably finished; the negative assertion cannot outrun it.
    flushSync(() => root.render(<Probe cwd={null} />));
    expect(completion.completion).toBeNull();
    flushSync(() => completion.follow("@HOST", 5));
    await app.renderOnce();
    expect(completion.completion).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The keys a list answers, as the terminal reports them. */
const key = (name: string, shift = false) => ({ name, shift, ctrl: false, meta: false }) as KeyEvent;

/** The completion hook over `commands`, with the draft the editor holds and the commands enter ran. */
async function listing(commands: Command[]) {
  const set: string[] = [];
  const editor = { current: { set: (text: string) => set.push(text) } as unknown as EditorHandle };
  let completion!: ReturnType<typeof useCompletion>;
  function Probe() {
    completion = useCompletion(editor, commands, null);
    return null;
  }
  const app = await createTestRenderer({ width: 40, height: 8 });
  const root = createRoot(app.renderer);
  flushSync(() => root.render(<Probe />));
  const ran: string[] = [];
  return {
    get completion() {
      return completion;
    },
    set,
    ran,
    type: (text: string) => flushSync(() => completion.follow(text, text.length)),
    press: (pressed: KeyEvent) => completion.key(pressed, false, (command) => ran.push(command)),
    close() {
      flushSync(() => root.unmount());
      app.renderer.destroy();
    },
  };
}

const COMMANDS: Command[] = [
  { name: "compact", description: "", source: "builtin", args: "[instructions]" },
  { name: "copy", description: "", source: "builtin" },
  { name: "name", description: "", source: "builtin", args: "<name>" },
  { name: "skill:release-notes", description: "", source: "skill", args: "[request]" },
];

test("enter runs only a command named in full, and completes a half-typed one", async () => {
  const list = await listing(COMMANDS);
  try {
    list.type("/co");
    expect(list.completion.shown?.runs).toBe(false);
    expect(list.press(key("return"))).toBe(true);
    expect(list.ran).toEqual([]);
    expect(list.set).toEqual(["/compact "]);
    list.type("/copy");
    expect(list.completion.shown?.runs).toBe(true);
    list.press(key("return"));
    expect(list.ran).toEqual(["/copy"]);
    // A command that needs its argument, and a skill, which frames a request, take one first.
    list.type("/name");
    list.press(key("return"));
    list.type("/skill:release-notes");
    list.press(key("return"));
    expect(list.ran).toEqual(["/copy"]);
    expect(list.set).toEqual(["/compact ", "/name ", "/skill:release-notes "]);
  } finally {
    list.close();
  }
});

test("keys in a burst each move the choice, and shift+tab moves it back", async () => {
  const list = await listing(COMMANDS);
  try {
    list.type("/");
    // Three downs before React draws land three rows on.
    for (let step = 0; step < 3; step++) list.press(key("down"));
    list.press(key("tab"));
    expect(list.set.at(-1)).toBe("/skill:release-notes ");
    list.press(key("tab", true));
    list.press(key("tab"));
    expect(list.set.at(-1)).toBe("/name ");
  } finally {
    list.close();
  }
});
