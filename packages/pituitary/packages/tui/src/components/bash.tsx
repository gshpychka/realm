import { pathToFileURL } from "node:url";
import type { BashEntry } from "@pituitary/session";
import { memo } from "react";
import { KeyHint } from "../keymap-context.tsx";
import { tilde } from "../place.ts";
import { counted } from "../plural.ts";
import { palette, theme } from "../theme.ts";
import { Link } from "./link.tsx";

/** Lines a command shows at full length, before the earlier ones are cut. */
const WHOLE_LINES = 400;

export interface BashViewProps {
  entry: BashEntry;
  /** The whole output, as ctrl+o asks. */
  expanded: boolean;
  /** Output lines shown until then: the latest ones. */
  rows: number;
  /** The keys that reach the interrupt from where the draft stands, such as `esc esc`. */
  escapes: string;
}

/**
 * A shell command the operator ran: the command, in the operator's colours, then its latest
 * output and how it ended. A command run with `!!` says its output stays out of pi's context.
 */
export const BashView = memo(function BashView({ entry, expanded, rows, escapes }: BashViewProps) {
  const all = entry.output.replace(/\n+$/, "").split("\n");
  const lines = all.length === 1 && all[0] === "" ? [] : all;
  const shown = lines.slice(-(expanded ? WHOLE_LINES : rows));
  const hidden = lines.length - shown.length;
  const running = entry.running !== undefined;
  const failed = entry.error ?? (entry.exitCode ? `exit ${entry.exitCode}` : undefined);
  // How it ended, or that it still runs, and whether pi will see it.
  const outcome: (readonly [text: string, colour: string])[] = [
    ...(running ? [[`◌ running${escapes ? ` · ${escapes} stops` : ""}`, theme.tool] as const] : []),
    ...(entry.cancelled ? [["cancelled", theme.tool] as const] : []),
    ...(failed ? [[`✗ ${failed}`, theme.error] as const] : []),
    ...(!running && !entry.cancelled && !failed && shown.length === 0
      ? [["no output", theme.dim] as const]
      : []),
    ...(entry.excluded ? [["not in pi's context", theme.dim] as const] : []),
  ];
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
        {/* A command keeps its latest lines, so what was cut comes before them. */}
        {hidden > 0 ? (
          <text selectable={false} fg={theme.dim}>
            … {counted(hidden, "earlier line")}
            {expanded ? null : <KeyHint action="app.tools.expand" />}
          </text>
        ) : null}
        {shown.length > 0 ? <text fg={theme.dim}>{shown.join("\n")}</text> : null}
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
