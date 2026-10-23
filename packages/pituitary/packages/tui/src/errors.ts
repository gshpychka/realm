/** An error as the operator reads it: one line on what went wrong, and what deals with it. */
export interface Explanation {
  text: string;
  /** The words the error arrived in, present when `text` rewords them. */
  original?: string;
}

/** Characters of an error's line kept before it is cut at a word. */
const KEPT = 160;

/** Condense native runtime, provider and tool errors while retaining the original for inspection. */
export function explain(text: string): Explanation {
  const brief = condense(text);
  return brief === text.trim() ? { text: brief } : { text: brief, original: text };
}

/** The first line of `text` worth reading, cut to `KEPT` characters. */
function condense(text: string): string {
  const said = unwrapJson(text.split(/\n\s*at\s|;?\s*\bstack=/)[0] ?? text)
    .replace(/<(?:!doctype html|html)\b[\s\S]*?(?:<\/html>|$)/i, page)
    // A sentence followed by `key=value` diagnostics, as pi-ai's OAuth errors end.
    .replace(/\.\s+[a-z_]+=[\s\S]*$/i, ".")
    .replace(/^\s*[A-Za-z]*Error:\s+/, "");
  const line = said
    .split("\n")
    .map((each) => each.trim())
    .find(Boolean);
  return clip(line ?? text.trim(), KEPT);
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
    const said = bodyMessage(text.slice(open, close + 1));
    if (said === null) continue;
    out += text.slice(from, open) + said;
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
