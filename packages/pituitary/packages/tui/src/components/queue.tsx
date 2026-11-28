import { useTerminalDimensions } from "@opentui/react";
import type { SessionView } from "@pituitary/session";
import { glyphs } from "../glyphs.ts";
import { counted } from "../plural.ts";
import { ellipsize } from "../text-width.ts";
import { theme } from "../theme.ts";
import { parseUserText, skillsIn } from "../user-text.ts";
import { SkillChip, skillChipWidth } from "./user-message.tsx";

/** A queued message on one row: the skills it loads, then its words with every break a space. */
function rowOf(text: string): { skills: string[]; words: string } {
  const segments = parseUserText(text);
  return {
    skills: [...new Set(skillsIn(segments).map((skill) => skill.name))],
    words: segments
      .flatMap((segment) => (segment.kind === "text" ? [segment.text] : []))
      .join(" ")
      .replace(/\s+/g, " "),
  };
}

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
    ...queue.steering.map((text) => ({ kind: `${glyphs.steering} steering`, ...rowOf(text) })),
    ...queue.followUp.map((text) => ({ kind: `${glyphs.followUp} follow-up`, ...rowOf(text) })),
  ];
  const { width } = useTerminalDimensions();
  if (messages.length === 0 || rows <= 0) return null;
  const hint = dequeue ? `${dequeue} edits queued messages` : "";
  const count = Math.max(0, rows - (hint ? 1 : 0));
  const shown = messages.slice(0, count < messages.length ? Math.max(0, count - 1) : count);
  const hidden = messages.length - shown.length;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {shown.map((row, index) => {
        const chips = row.skills.reduce((cells, name) => cells + skillChipWidth(name) + 1, 0);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: queued messages are identified by position
          <box key={index} flexDirection="row" flexShrink={0}>
            <text selectable={false} fg={theme.tool} flexShrink={0} wrapMode="none">
              {row.kind}{" "}
            </text>
            <text fg={theme.dim} flexShrink={1} wrapMode="none">
              {row.skills.map((name) => (
                <span key={name}>
                  <SkillChip name={name} />{" "}
                </span>
              ))}
              {/* Cut at the end, after the padding, the kind with its space, and the chips. */}
              {ellipsize(row.words, Math.max(0, width - 2 - Bun.stringWidth(row.kind) - 1 - chips))}
            </text>
          </box>
        );
      })}
      {hidden > 0 && (rows > 1 || !hint) ? (
        <text selectable={false} fg={theme.dim} wrapMode="none">
          {ellipsize(`… ${counted(hidden, "queued message")}`, width - 2)}
        </text>
      ) : null}
      {hint ? (
        <text selectable={false} fg={theme.dim} wrapMode="none">
          {ellipsize(`${rows === 1 ? `${messages.length} queued · ` : ""}${hint}`, width - 2)}
        </text>
      ) : null}
    </box>
  );
}
