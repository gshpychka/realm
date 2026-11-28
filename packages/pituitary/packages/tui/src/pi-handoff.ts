import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiModel } from "./cli.ts";

/** Where Pi's own screens left off: the session Pi ends on, and the model it runs there. */
export interface HandoffResult {
  sessionFile?: string;
  model?: PiModel;
}

/**
 * Loaded only for a handoff to Pi's own screens. Pi replaces this runtime with a fresh one
 * for each session it moves to there, and the fresh one loads this file again, so both read
 * the same environment and every runtime records where it is: the last one wins. A runtime
 * records again as it shuts down, after any model the operator chose there.
 */
export default function handoff(pi: ExtensionAPI): void {
  const command = process.env.PITUITARY_HANDOFF;
  const result = process.env.PITUITARY_HANDOFF_RESULT;
  if (!command || !result) return;
  const record = (ctx: ExtensionContext) => {
    const recorded: HandoffResult = {
      sessionFile: ctx.sessionManager.getSessionFile(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
    };
    writeFileSync(result, JSON.stringify(recorded), { mode: 0o600 });
  };
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
