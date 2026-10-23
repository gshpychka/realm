import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { createRef } from "react";
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
