import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Entry } from "@pituitary/session";
import { type ReactNode, useMemo } from "react";
import { IMAGE_TOKEN } from "../attachments.ts";
import { glyphs } from "../glyphs.ts";
import { IMAGE_CHIP } from "../image-chip.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { tilde } from "../place.ts";
import { palette, theme } from "../theme.ts";
import { parseUserText, type Segment, skillsIn } from "../user-text.ts";
import { Link } from "./link.tsx";

/** What a skill's chip says, between its rounded ends. */
const skillLabel = (name: string) => `${glyphs.skill} skill ${name}`;

/** Cells a skill's chip takes, its rounded ends included. */
export function skillChipWidth(name: string): number {
  return Bun.stringWidth(`${glyphs.chipStart}${skillLabel(name)}${glyphs.chipEnd}`);
}

/**
 * A skill among a message's words: a pill with rounded ends, like an image's, for use inside a
 * `<text>`. Its colours are `theme.skill` on `theme.skillTint`.
 */
export function SkillChip({ name }: { name: string }) {
  return (
    <>
      <span fg={theme.skillTint}>{glyphs.chipStart}</span>
      <span fg={theme.skill} bg={theme.skillTint}>
        {skillLabel(name)}
      </span>
      <span fg={theme.skillTint}>{glyphs.chipEnd}</span>
    </>
  );
}

/** A message's text, with `[image N]` drawn as a chip for each of the `images` it carries. */
function withImageChips(text: string, images: number): ReactNode {
  if (images === 0) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(IMAGE_TOKEN)) {
    const n = Number(match[1]);
    if (n < 1 || n > images) continue;
    parts.push(
      text.slice(from, match.index),
      <span key={`${match.index}-start`} fg={theme.imageTint}>
        {IMAGE_CHIP.start}
      </span>,
      <span key={`${match.index}-label`} fg={theme.image} bg={theme.imageTint}>
        {`${IMAGE_CHIP.label}${n}`}
      </span>,
      <span key={`${match.index}-stop`} fg={theme.imageTint}>
        {IMAGE_CHIP.stop}
      </span>,
    );
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

/**
 * The message's parts as one flow of words: each skill as its chip with the words after it,
 * its request, on the same line, and a blank line between one such part and the next.
 */
function flow(segments: readonly Segment[], images: number): ReactNode[] {
  return segments.map((segment, index) => {
    const before = segments[index - 1];
    const gap = index === 0 ? "" : before?.kind === "skill" && segment.kind === "text" ? " " : "\n\n";
    return segment.kind === "skill" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts are identified by position
      <span key={index}>
        {gap}
        <SkillChip name={segment.name} />
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts are identified by position
      <span key={index}>
        {gap}
        {withImageChips(segment.text, images)}
      </span>
    );
  });
}

/**
 * The operator's message. A skill it loaded shows as a chip before the request, as typed;
 * expanded, as ctrl+o asks, the skill's file and its instructions follow, dim and as the model
 * read them.
 */
export function UserMessage({
  entry,
  expanded,
}: {
  entry: Extract<Entry, { kind: "user" }>;
  expanded: boolean;
}) {
  const expand = useKeyHint("app.tools.expand");
  const segments = useMemo(() => parseUserText(entry.text), [entry.text]);
  const skills = skillsIn(segments);
  return (
    <box flexDirection="row" flexShrink={0} marginTop={1} backgroundColor={palette.surface} paddingRight={1}>
      <text selectable={false} fg={theme.user} flexShrink={0}>
        ▌{" "}
      </text>
      {skills.length === 0 ? (
        <text fg={theme.assistant}>{withImageChips(entry.text, entry.images)}</text>
      ) : (
        <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          {/* Text wraps at any space, so the key that shows the skill keeps a column of its
              own after the words, level with their last row, rather than flowing with them
              onto a row by itself. */}
          <box flexDirection="row" alignItems="flex-end">
            <text fg={theme.assistant} flexShrink={1} minWidth={0}>
              {flow(segments, entry.images)}
            </text>
            {!expanded && expand ? (
              <text selectable={false} fg={theme.dim} flexShrink={0} wrapMode="none">
                {` · ${expand}`}
              </text>
            ) : null}
          </box>
          {expanded
            ? skills.map((skill, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a message's skills are identified by position
                <box key={index} flexDirection="column" flexShrink={0} marginTop={1}>
                  <text fg={theme.dim}>
                    {isAbsolute(skill.location) ? (
                      <Link href={pathToFileURL(skill.location).href}>{tilde(skill.location)}</Link>
                    ) : (
                      skill.location
                    )}
                  </text>
                  <text fg={theme.thinking}>{skill.body}</text>
                </box>
              ))
            : null}
        </box>
      )}
    </box>
  );
}
