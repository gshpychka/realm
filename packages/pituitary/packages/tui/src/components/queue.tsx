import type { SessionView } from "@pituitary/rpc";
import { glyphs } from "../glyphs.ts";
import { theme } from "../theme.ts";

/** Messages waiting for the agent, in the order pi delivers them. */
export function Queue({
  queue,
  dequeue,
}: {
  queue: SessionView["queue"];
  /** The key that takes the queue back into the editor, when one is bound. */
  dequeue?: string;
}) {
  const rows = [
    ...queue.steering.map((text) => ({ kind: `${glyphs.steering} steering`, text })),
    ...queue.followUp.map((text) => ({ kind: `${glyphs.followUp} follow-up`, text })),
  ];
  if (rows.length === 0) return null;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: queued messages are identified by position
        <text key={index} fg={theme.dim} truncate wrapMode="none">
          <span fg={theme.tool}>{row.kind}</span> {row.text.replace(/\s+/g, " ")}
        </text>
      ))}
      {dequeue ? <text fg={theme.dim}>{dequeue} edits queued messages</text> : null}
    </box>
  );
}
