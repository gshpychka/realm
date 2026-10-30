import type { SessionView } from "@pituitary/session";
import { glyphs } from "../glyphs.ts";
import { counted } from "../plural.ts";
import { theme } from "../theme.ts";

/** Messages waiting for the agent, in the order pi delivers them. */
export function Queue({
  queue,
  dequeue,
  rows = Number.POSITIVE_INFINITY,
}: {
  queue: SessionView["queue"];
  /** The key that takes the queue back into the editor, when one is bound. */
  dequeue?: string;
  /** Rows available after preserving the draft and footer. */
  rows?: number;
}) {
  const messages = [
    ...queue.steering.map((text) => ({ kind: `${glyphs.steering} steering`, text })),
    ...queue.followUp.map((text) => ({ kind: `${glyphs.followUp} follow-up`, text })),
  ];
  if (messages.length === 0 || rows <= 0) return null;
  const hint = dequeue ? `${dequeue} edits queued messages` : "";
  const count = Math.max(0, rows - (hint ? 1 : 0));
  const shown = messages.slice(0, count < messages.length ? Math.max(0, count - 1) : count);
  const hidden = messages.length - shown.length;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {shown.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: queued messages are identified by position
        <box key={index} flexDirection="row" flexShrink={0}>
          <text selectable={false} fg={theme.tool} flexShrink={0} wrapMode="none">
            {row.kind}{" "}
          </text>
          <text fg={theme.dim} flexShrink={1} truncate wrapMode="none">
            {row.text.replace(/\s+/g, " ")}
          </text>
        </box>
      ))}
      {hidden > 0 && (rows > 1 || !hint) ? (
        <text selectable={false} fg={theme.dim} truncate wrapMode="none">
          … {counted(hidden, "queued message")}
        </text>
      ) : null}
      {hint ? (
        <text selectable={false} fg={theme.dim} truncate wrapMode="none">
          {rows === 1 ? `${messages.length} queued · ` : ""}
          {hint}
        </text>
      ) : null}
    </box>
  );
}
