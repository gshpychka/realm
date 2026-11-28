import { pathToFileURL } from "node:url";
import type { BashEntry } from "@pituitary/session";
import { memo } from "react";
import { KeyHint } from "../keymap-context.tsx";
import { tilde } from "../place.ts";
import { counted } from "../plural.ts";
import { tailRows } from "../text-width.ts";
import { palette, theme } from "../theme.ts";
import { Link } from "./link.tsx";
import { STATE } from "./tool-call.tsx";

/** Rows of output a command shows at most, even as ctrl+o asks for all of it: its latest. */
const WHOLE_ROWS = 400;
/** Cells the conversation's padding, its scrollbar and the output's indent leave out of each row. */
const MARGIN = 5;

export interface BashViewProps {
  entry: BashEntry;
  /** The whole output, as ctrl+o asks. */
  expanded: boolean;
  /** Rows of output shown until then: the latest ones. */
  rows: number;
  /** The terminal's width, which the output wraps within. */
  columns: number;
  /**
   * The keys that stop the command from where the draft stands, such as `esc esc`; empty while
   * the interrupt stops something else first, such as a run.
   */
  stops: string;
}

/**
 * A shell command the operator ran: the command, in the operator's colours, then its latest
 * output and how it ended. The output is bounded by the rows it takes on screen, so one long
 * line cannot fill it. A command run with `!!` says its output stays out of pi's context.
 */
export const BashView = memo(function BashView({ entry, expanded, rows, columns, stops }: BashViewProps) {
  const all = entry.output.replace(/\n+$/, "").split("\n");
  const lines = all.length === 1 && all[0] === "" ? [] : all;
  const { shown, hidden } = tailRows(lines, columns - MARGIN, expanded ? WHOLE_ROWS : rows);
  const running = entry.running !== undefined;
  const failed = entry.error ?? (entry.exitCode ? `exit ${entry.exitCode}` : undefined);
  // How it ended, or that it still runs, and whether pi will see it.
  const outcome: (readonly [text: string, colour: string])[] = [
    ...(running
      ? [[`${STATE.running.glyph} running${stops ? ` · ${stops} stops` : ""}`, STATE.running.colour] as const]
      : []),
    ...(entry.cancelled ? [["cancelled", theme.dim] as const] : []),
    ...(failed ? [[`${STATE.error.glyph} ${failed}`, STATE.error.colour] as const] : []),
    ...(!running && !entry.cancelled && !failed && shown.length === 0
      ? [["no output", theme.dim] as const]
      : []),
    ...(entry.excluded ? [["not in pi's context", theme.dim] as const] : []),
  ];
  // Pi keeps only the end of a long output for the session; the file it names holds all of it.
  const kept = entry.truncated
    ? `Pi kept only the last ${counted(lines.length, "line")}${entry.fullOutputPath ? " · full output below" : ""}`
    : null;
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <box flexDirection="row" flexShrink={0} backgroundColor={palette.surface} paddingRight={1}>
        <text selectable={false} fg={theme.user} flexShrink={0}>
          ▌{" "}
        </text>
        <text selectable={false} fg={entry.excluded ? theme.dim : theme.tool} flexShrink={0}>
          ${" "}
        </text>
        <text fg={theme.assistant}>{entry.command}</text>
      </box>
      <box flexDirection="column" flexShrink={0} paddingLeft={2}>
        {/* A command keeps its latest rows, so what was cut comes before them. */}
        {hidden > 0 || kept ? (
          <text selectable={false} fg={theme.dim}>
            …{hidden > 0 ? ` ${counted(hidden, "earlier line")}` : null}
            {hidden > 0 && !expanded ? <KeyHint action="app.tools.expand" /> : null}
            {kept ? `${hidden > 0 ? " · " : " "}${kept}` : null}
          </text>
        ) : null}
        {shown.length > 0 ? (
          <text fg={theme.dim} wrapMode="none">
            {shown.join("\n")}
          </text>
        ) : null}
        {outcome.length > 0 ? (
          <text selectable={false} wrapMode="word">
            {outcome.map(([text, colour], index) => (
              <span key={text} fg={colour}>
                {index > 0 ? " · " : ""}
                {text}
              </span>
            ))}
          </text>
        ) : null}
        {entry.fullOutputPath ? (
          <text fg={theme.dim}>
            full output:{" "}
            <Link href={pathToFileURL(entry.fullOutputPath).href}>{tilde(entry.fullOutputPath)}</Link>
          </text>
        ) : null}
      </box>
    </box>
  );
});
