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

/** Commands whose UI is a pi-tui component, the kind pi's RPC mode does not draw. */
export default function custom(pi: ExtensionAPI) {
  pi.registerCommand("flavour", {
    description: "Choose a flavour from a component list",
    handler: async (_args, ctx) => {
      const { SelectList } = (await import(PI_TUI)) as { SelectList: SelectListClass };
      const picked = await ctx.ui.custom<string | undefined>((_tui, theme, _keys, done) => {
        const list = new SelectList(
          [
            { value: "vanilla", label: "vanilla", description: "plain" },
            { value: "pistachio", label: "pistachio", description: "green" },
            { value: "mango", label: "mango", description: "sharp" },
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
      ctx.ui.notify(`flavour: ${picked ?? "none"}`, "info");
    },
  });
  pi.registerCommand("quiet", {
    description: "Finish without showing anything",
    handler: async () => {},
  });
  pi.registerCommand("gauge", {
    description: "Show a component widget",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget("gauge", (_tui, theme) => ({
        render: (width: number) => [theme.fg("accent", `gauge ${"#".repeat(Math.min(10, width - 6))}`)],
        invalidate: () => {},
      }));
    },
  });
}
