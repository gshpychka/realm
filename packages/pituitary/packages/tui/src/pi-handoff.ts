import { writeFileSync } from "node:fs";

/** Loaded only for a deliberate terminal handoff; regular sessions need no companion extension. */
export default function handoff(pi: {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: {
    ui: { setEditorText(text: string): void; notify(text: string, level: "info"): void };
    sessionManager: { getSessionFile(): string | undefined };
  }) => void): void;
}): void {
  const command = process.env.PITUITARY_HANDOFF;
  const result = process.env.PITUITARY_HANDOFF_RESULT;
  delete process.env.PITUITARY_HANDOFF;
  delete process.env.PITUITARY_HANDOFF_RESULT;
  if (!command) return;
  pi.on("session_start", (_event, context) => {
    context.ui.setEditorText(command);
    context.ui.notify(`Press enter to run ${command}, then quit Pi to return to Pituitary.`, "info");
  });
  if (result) pi.on("session_shutdown", (_event, context) => {
    writeFileSync(result, context.sessionManager.getSessionFile() ?? "", { mode: 0o600 });
  });
}
