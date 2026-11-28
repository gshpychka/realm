import { type Activity, activityOf, elapsed, type SessionView, type TurnEntry } from "@pituitary/session";
import { glyphs } from "./glyphs.ts";
import { ellipsize } from "./text-width.ts";

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
 * drop from the end, where the token count follows the interrupt key, and then what it does
 * is cut at its end.
 */
export function workingLine(view: SessionView, now: number, escapes: string, columns: number): WorkingLine {
  const activity = activityOf(view);
  const tokens = view.output.finished + view.output.streaming;
  const figures = [
    duration(elapsed(view, now)),
    // An open dialog takes the interrupt key for its own cancel.
    activity.kind === "operator" || !escapes ? null : `${escapes} interrupts`,
    tokens > 0 ? `${glyphs.tokens} ${count(tokens)}` : null,
  ].filter((part) => part !== null);
  const said = ellipsize(doing(activity), columns);
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
    case "preparing":
      return `${glyphs.tool} preparing ${activity.tool || "a tool call"}`;
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

/** What the working line says of the models giving second opinions, by name. */
export function consultingWords(models: readonly string[]): string {
  return `${glyphs.opinion} ${models.length === 1 ? models[0] : `${models.length} models`} weighing in`;
}

/**
 * A finished turn's figures as one line: the time it worked, its output tokens, and the time of
 * day it ended, which `at` keeps from reading as another duration.
 */
export function turnLine(turn: TurnEntry): string {
  return [
    `${glyphs.turn} ${duration(turn.worked)}`,
    turn.output > 0 ? `${glyphs.tokens} ${count(turn.output)}` : null,
    `at ${clock(turn.endedAt)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * The command that starts regular Pituitary again on session `id` from a shell in `here`. A
 * session Pi moved to another project, `cwd`, starts there: Pi finds a session id in the
 * project it starts in, and offers to fork one it finds elsewhere. The id is whole: Pi resolves
 * a partial one by its prefix, and a UUIDv7's leading digits are the time it was made, which
 * sessions started together share.
 */
export function resumeCommand(id: string, cwd: string, here = process.cwd()): string {
  return `${cwd === here ? "" : `cd ${shellWord(cwd)} && `}pituitary --session ${id}`;
}

/** `word` as one shell word. */
function shellWord(word: string): string {
  return /^[\w./~@%+=:,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * What brings the agent back once it cannot be reached: the key that reloads a Dura frontend,
 * which `reload` names, or `resume`, the command that starts Pi again on a session with
 * something to resume.
 */
export function reconnectHint(reload: string | null, resume: string | undefined): string {
  if (reload) return `Disconnected · ${reload} reloads this frontend`;
  if (resume) return `Disconnected · run ${resume}`;
  return "Disconnected · restart pituitary to reconnect";
}

/** Milliseconds to a tenth of a second under ten seconds, and as `duration` words them past that. */
export function span(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : duration(ms);
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

/** A session's estimated cost in dollars, to the cent, as the footer and /session show it. */
export function dollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** A token count in a few characters, rounded down so it never overstates. */
export function count(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.floor(tokens / 1_000)}k`;
  return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`;
}
