import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRenderer } from "@opentui/core";

/**
 * The draft after the operator edits it in `$PITUITARY_EDITOR`, `$VISUAL`, `$EDITOR`, or vi, with the UI
 * handing the terminal over for the duration. `null` when the editor fails.
 */
export function editExternally(renderer: CliRenderer, draft: string): string | null {
  let dir: string | undefined;
  let suspended = false;
  try {
    dir = mkdtempSync(join(tmpdir(), "pituitary-"));
    const file = join(dir, "prompt.md");
    writeFileSync(file, draft);
    const editor = process.env.PITUITARY_EDITOR || process.env.VISUAL || process.env.EDITOR || "vi";
    renderer.suspend();
    suspended = true;
    // The editor variable may carry its own arguments, so the shell splits it.
    const run = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    if (run.status !== 0) return null;
    return readFileSync(file, "utf8").replace(/\n+$/, "");
  } catch {
    // An editor may remove its file or fail to save it; preserve the draft just as on a bad exit.
    return null;
  } finally {
    if (suspended) renderer.resume();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Cleanup must not cover the UI with stderr. */
      }
    }
  }
}
