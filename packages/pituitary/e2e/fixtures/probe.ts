import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Raises every extension UI request from a command, so real pi exercises the UI with no model. */
export default function probe(pi: ExtensionAPI) {
  pi.registerCommand("probe", {
    description: "Ask through every dialog and report the answers",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("probe", "\x1b[32mprobe live\x1b[39m");
      ctx.ui.setWidget("probe", ["probe widget line"]);
      const choice = await ctx.ui.select("Pick a colour", ["amber", "teal"]);
      const sure = await ctx.ui.confirm("Keep it?", `picked ${choice}`);
      const name = await ctx.ui.input("Name it", "a name");
      ctx.ui.notify(`probe: ${choice} ${sure} ${name}`, "info");
    },
  });
  pi.registerCommand("note", {
    description: "Put a custom message in the conversation",
    handler: async () => {
      pi.sendMessage({ customType: "probe", content: "probe note", display: true });
    },
  });
}
