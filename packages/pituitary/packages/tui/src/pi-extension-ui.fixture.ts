import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Extension UI for the polish scenario: a status, a widget, and a question that times out. */
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
}
