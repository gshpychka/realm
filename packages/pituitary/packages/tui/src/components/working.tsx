import { useTerminalDimensions } from "@opentui/react";
import type { SessionView } from "@pituitary/rpc";
import { type ReactNode, useEffect, useState } from "react";
import { explain } from "../errors.ts";
import { glyphs } from "../glyphs.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { palette, theme } from "../theme.ts";
import { type WorkingLine, workingLine } from "../working.ts";
import { MascotSlot, useMascotTakes } from "./mascot.tsx";

export interface WorkingProps {
  view: SessionView;
  /** A passing message about the keys, such as how to finish quitting. */
  hint: string | null;
  /** Why the agent can no longer be reached, once it cannot. */
  closed: string | null;
  /** The keys that reach the interrupt from where the draft stands, such as `esc esc`. */
  escapes: string;
}

/** The time now, redrawn each second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Whether the status line above the editor is up; a passing hint takes its words while it is. */
export function statusUp(view: SessionView, closed: string | null): boolean {
  return closed !== null || view.running || view.retry !== null || view.phase === "compacting";
}

/**
 * What pi is doing right now, above the editor: reading, thinking, writing, running a tool, waiting
 * on the operator, compacting, or waiting to retry, with the key that stops it. A passing
 * key hint takes the line's words, and the fire stays while pi works.
 */
export function Working({ view, hint, closed, escapes }: WorkingProps) {
  const clear = useKeyHint("app.clear");
  const exit = useKeyHint("app.exit");
  const now = useNow(view.running || view.retry !== null || view.phase === "compacting");
  const { width } = useTerminalDimensions();
  const beside = useMascotTakes("working") ? BESIDE_FIRE : PADDING;
  const tick = Math.floor(now / 1000);
  if (closed) {
    const quit = clear ? `${clear} twice to quit` : exit ? `${exit} to quit` : null;
    return (
      <Line text={hint ?? `pi stopped${quit ? ` · ${quit}` : ""}`} tone={hint ? theme.dim : theme.error} />
    );
  }
  if (view.retry) {
    const wait = Math.max(0, Math.ceil((view.retry.at - now) / 1000));
    return (
      <Busy
        text={
          hint ??
          `${glyphs.retrying} retrying ${view.retry.attempt}/${view.retry.maxAttempts} in ${wait}s${escapes ? ` · ${escapes} cancels` : ""} · ${explain(view.retry.error).text}`
        }
        tone={hint ? theme.dim : theme.error}
        tick={tick}
      />
    );
  }
  if (view.phase === "compacting")
    return (
      <Busy
        text={hint ?? `${glyphs.compacting} compacting${escapes ? ` · ${escapes} cancels` : ""}`}
        tone={hint ? theme.dim : theme.tool}
        tick={tick}
      />
    );
  if (view.running) {
    if (hint) return <Busy text={hint} tone={theme.dim} tick={tick} />;
    const line = workingLine(view, now, escapes, width - beside);
    const text = (
      <>
        <span fg={DOING[line.kind]}>{line.doing}</span>
        {line.figures}
      </>
    );
    return <Busy text={text} tone={theme.dim} tick={tick} />;
  }
  return null;
}

function Line({ text, tone = theme.dim }: { text: string; tone?: string }) {
  return (
    <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1}>
      <text fg={tone} truncate wrapMode="none">
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
const BESIDE_FIRE = PADDING + FIRE_COLS + 1;

/** The colour of what the run is doing; a wait on the operator stands out. */
const DOING: Record<WorkingLine["kind"], string> = {
  reading: palette.muted,
  thinking: palette.muted,
  writing: palette.muted,
  tools: theme.tool,
  operator: palette.yellow,
};

function Busy({ text, tone, tick }: { text: ReactNode; tone: string; tick: number }) {
  if (!useMascotTakes("working"))
    return (
      <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1}>
        <text fg={tone} truncate wrapMode="none" key={tick}>
          {text}
        </text>
      </box>
    );
  return (
    <box flexDirection="row" flexShrink={0} height={FIRE_ROWS} paddingLeft={1} paddingRight={1} gap={1}>
      <MascotSlot name="working" width={FIRE_COLS} height={FIRE_ROWS} />
      <box flexDirection="column" justifyContent="flex-end" flexGrow={1}>
        <text fg={tone} truncate wrapMode="none" key={tick}>
          {text}
        </text>
      </box>
    </box>
  );
}
