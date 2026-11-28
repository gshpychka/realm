import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Loaded only for a handoff to Pi's own screens. Pi replaces this runtime with a fresh one
 * for each session it moves to there, and the fresh one loads this file again, so both read
 * the same environment and every runtime records its session: the last one wins.
 */
export default function handoff(pi: ExtensionAPI): void {
  const command = process.env.PITUITARY_HANDOFF;
  const result = process.env.PITUITARY_HANDOFF_RESULT;
  if (!command || !result) return;
  const record = (ctx: ExtensionContext) =>
    writeFileSync(result, ctx.sessionManager.getSessionFile() ?? "", { mode: 0o600 });
  pi.on("session_start", (event, ctx) => {
    record(ctx);
    if (event.reason !== "startup") return;
    // Pi runs its own commands only as typed, so the command waits in the editor for enter.
    ctx.ui.setEditorText(command);
    ctx.ui.notify(
      `Press enter to run ${command}. Back to Pituitary: ctrl+d on an empty editor, or ctrl+c twice.`,
      "info",
    );
  });
  pi.on("session_shutdown", (_event, ctx) => record(ctx));
}
