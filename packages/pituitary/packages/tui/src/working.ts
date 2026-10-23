import { type Activity, activityOf, elapsed, type SessionView, type TurnEntry } from "@pituitary/rpc";
import { glyphs } from "./glyphs.ts";
import { counted } from "./plural.ts";

/** The status line's account of a run in progress. */
export interface WorkingLine {
  kind: Activity["kind"];
  /** What the run is doing, with its glyph. */
  doing: string;
  /** The time the run has taken, the key that interrupts it, and the tokens it has generated. */
  figures: string;
}

/**
 * The run in progress as the status line words it in `columns`. Figures that do not fit
 * drop from the end, where the token count follows the interrupt key.
 */
export function workingLine(view: SessionView, now: number, escapes: string, columns: number): WorkingLine {
  const activity = activityOf(view);
  const seconds = Math.round(elapsed(view, now) / 1000);
  const tokens = view.output.finished + view.output.streaming;
  const figures = [
    `${seconds}s`,
    // An open dialog takes the interrupt key for its own cancel.
    activity.kind === "operator" || !escapes ? null : `${escapes} interrupts`,
    tokens > 0 ? `${glyphs.tokens} ${count(tokens)}` : null,
  ].filter((part) => part !== null);
  const said = doing(activity);
  const joined = () => (figures.length === 0 ? "" : ` · ${figures.join(" · ")}`);
  while (figures.length > 0 && Bun.stringWidth(said + joined()) > columns) figures.pop();
  return { kind: activity.kind, doing: said, figures: joined() };
}

function doing(activity: Activity): string {
  switch (activity.kind) {
    case "reading":
      return `${glyphs.reading} reading`;
    case "thinking":
      return `${glyphs.thinking} thinking`;
    case "writing":
      return `${glyphs.writing} writing`;
    case "tools": {
      const [only, ...others] = activity.names;
      return `${glyphs.tool} ${others.length > 0 ? `${activity.names.length} tools` : only || "tool"}`;
    }
    case "operator":
      return `${glyphs.waiting} waiting on you`;
    default:
      return activity satisfies never;
  }
}

/** A finished turn's figures as one line, its outcome last when it did not end with a finished reply. */
export function turnLine(turn: TurnEntry): string {
  return [
    `${glyphs.turn} ${duration(turn.worked)}`,
    turn.output > 0 ? `${glyphs.tokens} ${count(turn.output)}` : null,
    turn.tools > 0 ? counted(turn.tools, "tool") : null,
    clock(turn.endedAt),
    turn.outcome ?? null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Milliseconds rounded to the second, in the largest two units past a minute. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The local time of day at `at`, on a 24-hour clock. */
export function clock(at: number): string {
  const time = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/** A token count in a few characters, rounded down so it never overstates. */
export function count(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1_000)}k`;
  return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`;
}
