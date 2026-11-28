/**
 * A user message in the parts it was built from. Pi expands a leading `/skill:name request`
 * into the skill's instructions followed by the request:
 *
 *     <skill name="NAME" location="FILE">
 *     References are relative to DIR.
 *
 *     BODY
 *     </skill>
 *
 *     REQUEST
 *
 * The transcript, the queue, prompt recall and fork drafts read a message through these parts,
 * so a skill shows as a chip and goes back into the draft as `/skill:name request`, never as
 * the expanded block. Pi's own `parseSkillBlock` reads one block that the whole message must
 * match; queued messages taken back together are joined by blank lines, so a block is read
 * wherever a paragraph starts, ending at the first `</skill>` line that ends the message or a
 * paragraph, as Pi's does.
 */

/** A skill Pi loaded into the message, with the instructions it carried. */
export interface SkillSegment {
  kind: "skill";
  name: string;
  /** The skill's file, as Pi named it. */
  location: string;
  /** The skill's instructions, without Pi's note on what its references are relative to. */
  body: string;
}

/** The operator's own words. */
export interface TextSegment {
  kind: "text";
  text: string;
}

export type Segment = SkillSegment | TextSegment;

/** What starts a command that loads a skill, as Pi reads it at the start of a prompt. */
export const SKILL_COMMAND = "/skill:";

/** The opening line of an expanded skill. Pi writes the attributes unescaped, so neither holds a quote. */
const OPENING = /<skill name="([^"\n]+)" location="([^"\n]+)">\n/y;
const CLOSING = "\n</skill>";
/** The line Pi puts before a skill's instructions. */
const PREAMBLE = /^References are relative to [^\n]*\.\n\n/;

/** `text` as the skills it loaded and the words around them, in order; plain text is one text segment. */
export function parseUserText(text: string): Segment[] {
  const segments: Segment[] = [];
  let words = 0;
  let at = 0;
  while (at < text.length) {
    const skill = skillAt(text, at);
    if (skill) {
      pushText(segments, text.slice(words, at));
      segments.push(skill.segment);
      at = words = skill.end;
      continue;
    }
    const paragraph = text.indexOf("\n\n", at);
    if (paragraph === -1) break;
    at = paragraph + 2;
  }
  pushText(segments, text.slice(words));
  return segments;
}

/** The skill block starting at `at`, with where its paragraph ends; null when none starts there. */
function skillAt(text: string, at: number): { segment: SkillSegment; end: number } | null {
  OPENING.lastIndex = at;
  const opening = OPENING.exec(text);
  if (!opening) return null;
  const start = OPENING.lastIndex;
  for (let close = text.indexOf(CLOSING, start); close !== -1; close = text.indexOf(CLOSING, close + 1)) {
    const after = close + CLOSING.length;
    if (after !== text.length && !text.startsWith("\n\n", after)) continue;
    return {
      segment: {
        kind: "skill",
        name: opening[1] ?? "",
        location: opening[2] ?? "",
        body: text.slice(start, close).replace(PREAMBLE, ""),
      },
      end: after,
    };
  }
  return null;
}

/** Adds the words between skills, without the blank lines that separate them from the skills. */
function pushText(segments: Segment[], text: string): void {
  const trimmed = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (trimmed.trim()) segments.push({ kind: "text", text: trimmed });
}

/**
 * The message as the operator would type it again: each skill as `/skill:name` with the words
 * that follow it as its request. Pi expands only a leading one, so a draft of a message that
 * loaded several says so in the editor's rule.
 */
export function asTyped(segments: readonly Segment[]): string {
  const paragraphs: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === "skill") paragraphs.push(`${SKILL_COMMAND}${segment.name}`);
    else if (segments[index - 1]?.kind === "skill") paragraphs.push(`${paragraphs.pop()} ${segment.text}`);
    else paragraphs.push(segment.text);
  }
  return paragraphs.join("\n\n");
}

/** `text`, a message Pi received, as the operator would type it again. */
export function typed(text: string): string {
  return asTyped(parseUserText(text));
}

/** The skills a message loaded, in order. */
export function skillsIn(segments: readonly Segment[]): SkillSegment[] {
  return segments.filter((segment) => segment.kind === "skill");
}
