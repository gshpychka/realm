import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** pi's own list component, loaded through pi's module table as an extension would. */
interface SelectList {
  onSelect?: (item: { value: string }) => void;
  onCancel?: () => void;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}
type SelectListClass = new (
  items: { value: string; label: string; description?: string }[],
  maxVisible: number,
  theme: Record<
    "selectedPrefix" | "selectedText" | "description" | "scrollInfo" | "noMatch",
    (text: string) => string
  >,
) => SelectList;

const PI_TUI = "@earendil-works/pi-tui";

/** A release helper for the showcase: pi's dialogs, a status, a widget, and a component of its own. */
export default function release(pi: ExtensionAPI) {
  pi.registerCommand("release", {
    description: "Cut a release: pick the bump, confirm, tag (dry run)",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("release", "\x1b[33mrelease in progress\x1b[39m");
      ctx.ui.setWidget("release", ["release · v1.3.2 → next", "changelog: 4 fixes, 1 feature"]);
      const { SelectList } = (await import(PI_TUI)) as { SelectList: SelectListClass };
      const bump = await ctx.ui.custom<string | undefined>((_tui, theme, _keys, done) => {
        const list = new SelectList(
          [
            { value: "patch", label: "patch  v1.3.3", description: "fixes only" },
            { value: "minor", label: "minor  v1.4.0", description: "adds the retry cap" },
            { value: "major", label: "major  v2.0.0", description: "breaking changes" },
          ],
          5,
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        );
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(undefined);
        return list;
      });
      const version = { patch: "v1.3.3", minor: "v1.4.0", major: "v2.0.0" }[bump ?? ""] ?? "none";
      const channel = await ctx.ui.select("Publish to which channel?", ["beta", "stable"]);
      const sure = await ctx.ui.confirm("Tag the release?", `${version} on ${channel}`);
      const note = sure ? await ctx.ui.input("Release note", "one line for the changelog") : undefined;
      ctx.ui.setStatus(
        "release",
        sure ? "\x1b[32mrelease tagged\x1b[39m" : "\x1b[31mrelease cancelled\x1b[39m",
      );
      ctx.ui.setWidget("release", undefined);
      ctx.ui.notify(
        sure ? `tagged ${version} on ${channel} (dry run): ${note ?? ""}` : "release cancelled",
        "info",
      );
    },
  });
}
