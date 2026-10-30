import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Loaded only for a deliberate terminal handoff. */
export default function handoff(pi: ExtensionAPI): void {
  const command = process.env.PITUITARY_HANDOFF;
  const result = process.env.PITUITARY_HANDOFF_RESULT;
  delete process.env.PITUITARY_HANDOFF;
  delete process.env.PITUITARY_HANDOFF_RESULT;
  if (!command) return;
  pi.on("session_start", (_event, context) => {
    context.ui.setEditorText(command);
    context.ui.notify(`Press enter to run ${command}, then quit Pi to return to Pituitary.`, "info");
  });
  if (result)
    pi.on("session_shutdown", (_event, context) => {
      writeFileSync(result, context.sessionManager.getSessionFile() ?? "", { mode: 0o600 });
    });
}
