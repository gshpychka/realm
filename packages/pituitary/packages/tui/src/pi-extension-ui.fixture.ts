import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extension UI for the polish scenario: a status, a widget, a question that times out, one too
 * long for the dialog, and an error reported with its stack.
 */
export default function polish(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("demo", "demo status");
    ctx.ui.setWidget("demo", ["demo widget line"], { placement: "belowEditor" });
  });
  pi.registerCommand("ask", {
    description: "ask a question that cancels itself",
    handler: async (_args, ctx) => {
      const picked = await ctx.ui.select("Allow rm -rf build?", ["Allow", "Block"], { timeout: 6000 });
      ctx.ui.notify(`picked: ${picked ?? "nothing"}`, "info");
    },
  });
  pi.registerCommand("ask-long", {
    description: "ask a question longer than the dialog",
    handler: async (_args, ctx) => {
      const question = Array.from({ length: 20 }, (_, line) => `question line ${line + 1}`).join("\n");
      const picked = await ctx.ui.select(question, ["Allow", "Block"]);
      ctx.ui.notify(`picked: ${picked ?? "nothing"}`, "info");
    },
  });
  pi.registerCommand("crash", {
    description: "report an error with its stack",
    handler: async (_args, ctx) => {
      try {
        JSON.parse("null").x;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? (error.stack ?? error.message) : String(error), "error");
      }
    },
  });
}
