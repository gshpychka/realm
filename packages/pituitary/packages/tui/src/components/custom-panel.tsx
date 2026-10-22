import { type BoxRenderable, type OptimizedBuffer, RGBA } from "@opentui/core";
import type { BridgeHost, CustomView } from "@pituitary/rpc";
import { useEffect, useMemo, useState } from "react";
import { parseAnsi, type Run } from "../ansi.ts";
import { theme } from "../theme.ts";

/** Marks where a focused pi-tui component keeps its cursor. */
const CURSOR_MARKER = "\x1b_pi:c\x07";

/** Components extensions have open, oldest first. */
export function useCustomViews(bridge: BridgeHost | undefined): readonly CustomView[] {
  const [views, setViews] = useState<readonly CustomView[]>([]);
  useEffect(() => bridge?.onChange(setViews), [bridge]);
  return views;
}

/** Rows of `lines` that fit in `rows`, keeping the component's cursor in view. */
export function visibleRows(lines: readonly string[], rows: number): readonly string[] {
  if (lines.length <= rows) return lines;
  const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  const top = cursor < 0 ? 0 : Math.max(0, Math.min(cursor - Math.floor(rows / 2), lines.length - rows));
  return lines.slice(top, top + rows);
}

/** Cuts `text` to at most `columns` cells. */
function clip(text: string, columns: number): string {
  if (Bun.stringWidth(text) <= columns) return text;
  let out = "";
  for (const char of text) {
    if (Bun.stringWidth(out + char) > columns) break;
    out += char;
  }
  return out;
}

/**
 * An extension's own component, drawn from the rows it renders inside pi.
 * It holds the keyboard while open; keys reach the component through the bridge.
 */
export function CustomPanel({ view, rows }: { view: CustomView; rows: number }) {
  const shown = visibleRows(view.lines, Math.max(1, rows));
  const parsed = useMemo(() => shown.map(parseAnsi), [shown]);
  const colours = useMemo(() => new Map<string, RGBA>(), []);
  const colour = (hex: string) => {
    let rgba = colours.get(hex);
    if (!rgba) {
      rgba = RGBA.fromHex(hex);
      colours.set(hex, rgba);
    }
    return rgba;
  };
  const text = colour(theme.assistant);

  function draw(this: BoxRenderable, buffer: OptimizedBuffer) {
    parsed.forEach((runs: Run[], row) => {
      if (row >= this.height) return;
      let column = 0;
      for (const run of runs) {
        const room = this.width - column;
        if (room <= 0) break;
        const cut = clip(run.text, room);
        buffer.drawText(
          cut,
          this.x + column,
          this.y + row,
          run.fg ? colour(run.fg) : text,
          run.bg ? colour(run.bg) : undefined,
          run.attributes,
        );
        column += Bun.stringWidth(cut);
      }
    });
  }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderColor={theme.user}
      paddingLeft={1}
      paddingRight={1}
      title=" ctrl+c closes "
      titleAlignment="right"
    >
      {shown.length === 0 ? (
        <text fg={theme.dim}>opening…</text>
      ) : (
        <box height={shown.length} flexShrink={0} renderAfter={draw} />
      )}
    </box>
  );
}
