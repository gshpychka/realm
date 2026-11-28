import { useTerminalDimensions } from "@opentui/react";
import { glyphs } from "../glyphs.ts";
import { hintLine } from "../hints.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { providerMark } from "../provider.ts";
import { palette, theme } from "../theme.ts";
import {
  dashboardUrl,
  isUsageStale,
  type MetricLine,
  metricLine,
  providerLine,
  sessionEstimateLine,
  singleLine,
  statusLine,
} from "../usage/presentation.ts";
import type { UsageMetric, UsageReport } from "../usage/types.ts";
import { Link } from "./link.tsx";

export interface UsagePanelProps {
  report: UsageReport;
  now: number;
  /** The running session's own token-cost estimate; the provider's account billing is separate. */
  sessionCost?: number;
  /** The interrupt's keys, such as `esc esc`, while they close the card: nothing runs for them to stop. */
  escapes?: string | undefined;
}

/** Share of the terminal's height the scrolled metrics and notes may fill. */
const PANEL_FRACTION = 0.4;
/** Rows the scrolled metrics and notes keep to even on a tall terminal. */
const PANEL_MAX_ROWS = 10;
const PANEL_MIN_ROWS = 3;

function scrollRows(terminalHeight: number): number {
  return Math.max(PANEL_MIN_ROWS, Math.min(PANEL_MAX_ROWS, Math.floor(terminalHeight * PANEL_FRACTION)));
}

/**
 * The account behind the current model, its metrics and notes, and the session's own cost
 * estimate kept visibly apart from it.
 *
 * Only the metrics and notes list is bounded to a share of the terminal's height; the header
 * rows above it are not. Its last row says how to close it and check again.
 */
export function UsagePanel({ report, now, sessionCost, escapes }: UsagePanelProps) {
  const { width, height } = useTerminalDimensions();
  const toggle = useKeyHint("app.usage.toggle");
  const mark = providerMark(report.provider);
  const stale = isUsageStale(report, now);
  const statusTone = report.state === "error" ? theme.error : stale ? palette.yellow : theme.dim;
  const hasBody = report.metrics.length > 0 || report.notes.length > 0;
  const closes = [toggle, escapes].filter(Boolean).join(" / ");
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme.bg}
      borderColor={theme.border}
      border={["top"]}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={mark.colour ?? theme.assistant} wrapMode="none" selectable={false}>
          {mark.glyph}{" "}
        </text>
        <text fg={theme.assistant} wrapMode="word" flexGrow={1}>
          {providerLine(report)}
        </text>
      </box>
      <text fg={statusTone} wrapMode="word">
        {statusLine(report, now)}
      </text>
      <text wrapMode="word">
        <Link href={dashboardUrl(report)} fg={theme.dim}>
          {glyphs.web} account dashboard
        </Link>
      </text>
      {hasBody ? (
        <scrollbox
          maxHeight={scrollRows(height)}
          scrollX={false}
          focusable={false}
          contentOptions={{ minHeight: 0 }}
        >
          <box flexDirection="column">
            {report.metrics.map((metric, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a report's metrics keep their order
              <MetricRow key={index} metric={metric} now={now} />
            ))}
            {report.notes.map((note, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a report's notes keep their order
              <text key={index} fg={theme.dim} wrapMode="word">
                {glyphs.info} {singleLine(note)}
              </text>
            ))}
          </box>
        </scrollbox>
      ) : null}
      {sessionCost !== undefined ? (
        <text fg={theme.dim} wrapMode="word">
          {sessionEstimateLine(sessionCost)}
        </text>
      ) : null}
      <text fg={theme.dim} wrapMode="none" selectable={false}>
        {hintLine(
          [
            [closes || "/usage off", "close"],
            ["/usage refresh", "updates"],
          ],
          null,
          width - 2,
        )}
      </text>
    </box>
  );
}

function MetricRow({ metric, now }: { metric: UsageMetric; now: number }) {
  const line: MetricLine = metricLine(metric, now);
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={line.expired ? palette.yellow : theme.assistant} wrapMode="word">
        {line.label}
      </text>
      <text fg={theme.dim} wrapMode="word">
        {line.detail}
      </text>
    </box>
  );
}
