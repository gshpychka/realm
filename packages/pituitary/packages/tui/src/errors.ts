/** An error as the operator reads it: one line on what went wrong, and what deals with it. */
export interface Explanation {
  text: string;
  /** What deals with the error, naming a command the operator can run, when one is known. */
  remedy?: string;
  /** What the error said that `text` leaves out, such as a stack or a raw response body. */
  detail?: string;
}

/** Characters of an error's line kept before it is cut at a word. */
const KEPT = 160;

/** What deals with errors whose words match; one naming a command is offered only while it can run. */
interface Remedy {
  matches: RegExp;
  command?: string;
  says: string;
}

/** Remedies by what the error says, the first match winning. */
const REMEDIES: readonly Remedy[] = [
  {
    matches:
      /prompt is too long|context (?:length|window|limit)|maximum context|exceeds? (?:the )?context|too many (?:input )?tokens/i,
    command: "compact",
    says: "/compact frees context",
  },
  {
    matches:
      /\b40[13]\b|unauthori[sz]ed|forbidden|invalid (?:x-)?(?:api[ _-]?key|token|credential)|(?:token|credential)s? (?:has )?expired|authentication (?:failed|error)/i,
    command: "login",
    says: "/login signs in again",
  },
  {
    matches: /\b(?:429|529)\b|rate.?limit|overloaded|too many requests/i,
    says: "wait a moment, then send again",
  },
];

/** A sentence naming the command that deals with an error, as Pi's own errors close. */
const USE = /^Use \/[a-z][\w:-]*\b[^.\n]*\./;

/**
 * Condense native runtime, provider and tool errors while retaining the rest for inspection.
 * A remedy names a command only while it is among `commands`, those the operator can run.
 */
export function explain(text: string, commands: ReadonlySet<string> = new Set()): Explanation {
  const headline = condense(text);
  const use = commandSentence(text, headline);
  const remedy = use ? undefined : remedyFor(text, commands);
  const detail = rest(text, headline, use);
  return {
    text: use ? `${headline} ${use}` : headline,
    ...(remedy ? { remedy } : {}),
    ...(detail ? { detail } : {}),
  };
}

function remedyFor(text: string, commands: ReadonlySet<string>): string | undefined {
  const found = REMEDIES.find((each) => each.matches.test(text));
  return found && (!found.command || commands.has(found.command)) ? found.says : undefined;
}

/** The first line of `text` worth reading, cut to `KEPT` characters. */
function condense(text: string): string {
  const line = said(text)
    .split("\n")
    .map((each) => each.trim())
    .find(Boolean);
  return clip(line ?? text.trim(), KEPT);
}

/** What `text` says once a stack, an HTML page, trailing diagnostics and JSON wrapping are taken out. */
function said(text: string): string {
  return (
    unwrapJson(text.split(/\n\s*at\s|;?\s*\bstack=/)[0] ?? text)
      .replace(/<(?:!doctype html|html)\b[\s\S]*?(?:<\/html>|$)/i, page)
      // A sentence followed by `key=value` diagnostics, as pi-ai's OAuth errors end.
      .replace(/\.\s+[a-z_]+=[\s\S]*$/i, ".")
      .replace(/^\s*[A-Za-z]*Error:\s+/, "")
  );
}

/** A later line's `Use /command …` sentence, which says in the error's own words what deals with it. */
function commandSentence(text: string, headline: string): string | null {
  for (const line of said(text).split("\n").slice(1)) {
    const sentence = USE.exec(line.trim())?.[0];
    if (sentence && !headline.includes(sentence)) return clip(sentence, KEPT);
  }
  return null;
}

/**
 * `text` without what the brief already shows, the line that reads as its headline and the
 * words of its `Use` sentence, so the detail adds a stack or a raw body rather than repeating.
 */
function rest(text: string, headline: string, use: string | null): string {
  return (use && !use.endsWith("…") ? text.replace(use, "") : text)
    .split("\n")
    .filter((line) => line.trim().replace(/^[A-Za-z]*Error:\s+/, "") !== headline)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An HTML page in an error, as its title. */
function page(html: string): string {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || "an HTML page";
}

const MESSAGE_KEYS = ["message", "error_description", "detail", "error", "title", "msg"] as const;

/** `text` with each JSON object in it replaced by the message it carries, where it carries one. */
function unwrapJson(text: string): string {
  let out = "";
  let from = 0;
  for (let open = text.indexOf("{"); open !== -1; open = text.indexOf("{", open + 1)) {
    if (open < from) continue;
    const close = closing(text, open);
    if (close === -1) continue;
    const message = bodyMessage(text.slice(open, close + 1));
    if (message === null) continue;
    out += text.slice(from, open) + message;
    from = close + 1;
  }
  return out + text.slice(from);
}

/** The index of the brace closing the object that opens at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/** The message a JSON response body carries, or null when it is not JSON or carries none. */
function bodyMessage(json: string): string | null {
  try {
    return messageOf(JSON.parse(json) as Json);
  } catch {
    return null;
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The human-readable message in a response body, searched by the keys APIs put it under. */
function messageOf(value: Json | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of MESSAGE_KEYS) {
    const found = messageOf(value[key]);
    if (found) return found;
  }
  return null;
}

function clip(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > chars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}
