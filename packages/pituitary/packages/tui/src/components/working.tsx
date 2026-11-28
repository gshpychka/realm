import { useTerminalDimensions } from "@opentui/react";
import type { SessionView } from "@pituitary/session";
import type { ReactNode } from "react";
import { explain } from "../errors.ts";
import { glyphs } from "../glyphs.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { ellipsize } from "../text-width.ts";
import { palette, theme } from "../theme.ts";
import { useNow } from "../use-now.ts";
import { consultingWords, type WorkingLine, workingLine } from "../working.ts";
import { MascotSlot, useMascotTakes } from "./mascot.tsx";

export interface WorkingProps {
  view: SessionView;
  /** A passing message about the keys, such as how to finish quitting. */
  hint: string | null;
  /** Why the agent can no longer be reached, once it cannot. */
  closed: string | null;
  /** The keys that reach the interrupt from where the draft stands, such as `esc esc`. */
  escapes: string;
  /** What the operator calls the agent, such as `pi` or `the builder` for a Dura task's role. */
  agent: string;
  /** A move through the session's tree is summarizing the branch it leaves. */
  summarizing?: boolean;
  /** The models giving second opinions, by name. */
  consulting?: readonly string[];
}

/** Whether the status line above the editor is up; a passing hint takes its words while it is. */
export function statusUp(
  view: SessionView,
  closed: string | null,
  summarizing = false,
  consulting: readonly string[] = [],
): boolean {
  return (
    closed !== null ||
    view.running ||
    view.retry !== null ||
    view.phase === "compacting" ||
    summarizing ||
    consulting.length > 0
  );
}

/**
 * What pi is doing right now, above the editor: reading, thinking, writing, running a tool, waiting
 * on the operator, compacting, or waiting to retry, with the key that stops it, and the models
 * giving second opinions. A passing key hint takes the line's words, and the fire stays while pi
 * works.
 */
export function Working({
  view,
  hint,
  closed,
  escapes,
  agent,
  summarizing = false,
  consulting = NOBODY,
}: WorkingProps) {
  const clear = useKeyHint("app.clear");
  const exit = useKeyHint("app.exit");
  const now = useNow(view.running || view.retry !== null || view.phase === "compacting");
  const { width } = useTerminalDimensions();
  // The busy line's words, cut at their end to what the padding and the fire leave.
  const room = width - (useMascotTakes("working") ? STATUS_INSET : PADDING);
  const tick = Math.floor(now / 1000);
  if (closed) {
    const quit = clear ? `${clear} twice to quit` : exit ? `${exit} to quit` : null;
    return (
      <Line
        text={hint ?? `${agent} stopped${quit ? ` · ${quit}` : ""}`}
        tone={hint ? theme.dim : theme.error}
      />
    );
  }
  if (hint && (view.retry || view.phase === "compacting" || view.running || summarizing || consulting.length))
    return <Busy text={ellipsize(hint, room)} tone={theme.dim} tick={tick} />;
  if (view.retry) {
    const wait = Math.max(0, Math.ceil((view.retry.at - now) / 1000));
    const retrying = `${glyphs.retrying} retrying ${view.retry.attempt}${view.retry.maxAttempts ? `/${view.retry.maxAttempts}` : ""} in ${wait}s${escapes ? ` · ${escapes} cancels` : ""}`;
    // The error takes what the countdown leaves, after its separator.
    const error = ellipsize(explain(view.retry.error).text, room - Bun.stringWidth(`${retrying} · `));
    return (
      <Busy
        text={ellipsize(error ? `${retrying} · ` : retrying, room)}
        error={error}
        tone={theme.error}
        tick={tick}
      />
    );
  }
  if (summarizing)
    return (
      <Busy
        text={ellipsize(
          `${glyphs.summary} summarizing the branch you leave${escapes ? ` · ${escapes} stops` : ""}`,
          room,
        )}
        tone={theme.tool}
        tick={tick}
      />
    );
  if (view.phase === "compacting")
    return (
      <Busy
        text={ellipsize(`${glyphs.compacting} compacting${escapes ? ` · ${escapes} cancels` : ""}`, room)}
        tone={theme.tool}
        tick={tick}
      />
    );
  if (view.running) {
    // The run's own words come first; the second opinions take what is left, up to half the line.
    const aside = consulting.length ? ` · ${consultingWords(consulting)}` : "";
    const beside = Bun.stringWidth(aside) <= room / 2 ? aside : "";
    const line = workingLine(view, now, escapes, room - Bun.stringWidth(beside));
    const text = (
      <>
        <span fg={DOING[line.kind]}>{line.doing}</span>
        {line.figures}
        {beside ? <span fg={theme.opinion}>{beside}</span> : null}
      </>
    );
    return <Busy text={text} tone={theme.dim} tick={tick} />;
  }
  if (consulting.length)
    return (
      <Busy
        text={ellipsize(
          `${consultingWords(consulting)} · /consult cancel stops ${consulting.length === 1 ? "it" : "them"}`,
          room,
        )}
        tone={theme.opinion}
        tick={tick}
      />
    );
  return null;
}

const NOBODY: readonly string[] = [];

/**
 * What is left once the agent cannot be reached, wrapped rather than cut: the command that
 * resumes its session, such as `cd <project> && pituitary --session <id>`, is whole or wrong.
 */
function Line({ text, tone = theme.dim }: { text: string; tone?: string }) {
  return (
    <box flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text selectable={false} fg={tone} wrapMode="word">
        {text}
      </text>
    </box>
  );
}

/** Room for the fire beside the status: two rows tall, which is the least a flame needs to have a tip. */
const FIRE_COLS = 5;
const FIRE_ROWS = 2;
/** Columns the busy line's padding takes from its words, and with the fire and its gap. */
const PADDING = 2;
export const STATUS_INSET = PADDING + FIRE_COLS + 1;

/** The colour of what the run is doing; a wait on the operator stands out. */
const DOING: Record<WorkingLine["kind"], string> = {
  reading: palette.muted,
  thinking: palette.muted,
  writing: palette.muted,
  preparing: theme.tool,
  tools: theme.tool,
  operator: palette.yellow,
};

/** The busy line, its words already cut to fit: a selectable error may follow what pi is doing. */
function Busy({ text, error, tone, tick }: { text: ReactNode; error?: string; tone: string; tick: number }) {
  const line = (
    <box flexDirection="row">
      <text selectable={false} fg={tone} flexShrink={0} wrapMode="none" key={tick}>
        {text}
      </text>
      {error ? (
        <text fg={tone} flexShrink={0} wrapMode="none">
          {error}
        </text>
      ) : null}
    </box>
  );
  if (!useMascotTakes("working"))
    return (
      <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1}>
        {line}
      </box>
    );
  return (
    <box flexDirection="row" flexShrink={0} height={FIRE_ROWS} paddingLeft={1} paddingRight={1} gap={1}>
      <MascotSlot name="working" width={FIRE_COLS} height={FIRE_ROWS} />
      <box flexDirection="column" justifyContent="flex-end" flexGrow={1}>
        {line}
      </box>
    </box>
  );
}
