/** An error as the operator reads it: one line on what went wrong, and what deals with it. */
export interface Explanation {
  text: string;
  remedy?: Remedy;
  /** The words the error arrived in, present when `text` rewords them. */
  original?: string;
}

/** A command that deals with an error, and what running it does. */
export interface Remedy {
  command: string;
  does: string;
}

/** Characters of an error's line kept before it is cut at a word. */
const KEPT = 160;

/** What a token endpoint answers when the stored login is no longer good. */
const REFUSED = /invalid_grant|expired|revoked|status=40[01]\b/i;

/** What a request that never reached its server fails with. */
const UNREACHABLE =
  /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|timed? ?out/i;

/** Why an MCP server did not connect, from the transport's words; the first match names it. */
const MCP_CAUSES: readonly [RegExp, string][] = [
  [/ECONNREFUSED|connection refused/i, "connection refused"],
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "host not found"],
  [/spawn \S+ ENOENT|command not found/i, "its command was not found"],
  [/ETIMEDOUT|timed? ?out/i, "timed out"],
  [/Connection closed/i, "the server closed the connection"],
];

/** An MCP connect failure that a login fixes. */
const MCP_SIGNED_OUT = /OAuth authentication required|\b401\b|unauthori[sz]ed|invalid_token|auth.?required/i;

const login = (provider: string): Remedy => ({ command: `/login ${provider}`, does: "signs in again" });

interface Known {
  /** The shape of the words, whose groups the reading takes. */
  words: RegExp;
  read(groups: string[], text: string): Omit<Explanation, "original">;
}

/** Errors whose source and shape are known, checked in order before any other reading. */
const KNOWN: readonly Known[] = [
  {
    // pi-ai's `resolveStoredOAuth`, wrapping whatever the provider's token endpoint said.
    words: /^OAuth refresh failed for ([^\s:]+)/,
    read: ([provider = ""], text) => {
      if (REFUSED.test(text)) return { text: `the ${provider} login has expired`, remedy: login(provider) };
      if (UNREACHABLE.test(text)) return { text: `could not reach ${provider} to renew the login` };
      return { text: `could not renew the ${provider} login`, remedy: login(provider) };
    },
  },
  {
    // pi's agent session, when a provider's stored login yields no credentials.
    words: /^Authentication failed for "([^"]+)"/,
    read: ([provider = ""]) => ({
      text: `the ${provider} login did not work: it may have expired, or the network is down`,
      remedy: login(provider),
    }),
  },
  {
    // pi's auth guidance, which names the provider or "the selected model".
    words: /^No API key found for (.+?)\.?$/m,
    read: ([what = ""]) => ({
      text: `no login or API key for ${what}`,
      remedy: { command: what === "the selected model" ? "/login" : `/login ${what}`, does: "signs in" },
    }),
  },
  {
    // A provider SDK's `401 {body}`, which names no provider.
    words: /^401\b:?\s*([\s\S]*)$/,
    read: ([rest = ""]) => ({
      text: `the provider refused the credentials: ${condense(rest)}`,
      remedy: { command: "/login", does: "signs in again" },
    }),
  },
  {
    // pi-mcp-adapter's notice when a server fails to connect at startup or on `/mcp reconnect`.
    words: /^MCP: Failed to (?:re)?connect to (\S+): ([\s\S]*)$/,
    read: ([server = "", reason = ""]) => {
      if (MCP_SIGNED_OUT.test(reason)) {
        return {
          text: `MCP server ${server} needs a login`,
          remedy: { command: `/mcp-auth ${server}`, does: "signs in" },
        };
      }
      const cause = MCP_CAUSES.find(([words]) => words.test(reason))?.[1] ?? condense(transportless(reason));
      return {
        text: `MCP server ${server} did not connect: ${cause}`,
        remedy: { command: `/mcp reconnect ${server}`, does: "tries again" },
      };
    },
  },
];

/**
 * What an error from pi, a provider, or an extension says, in one line the operator can act
 * on. Errors of a known source are reworded with a remedy; any other keeps its first line,
 * free of stack traces, response bodies, and diagnostics.
 */
export function explain(text: string): Explanation {
  for (const known of KNOWN) {
    const match = known.words.exec(text);
    if (match) return { ...known.read(match.slice(1), text), original: text };
  }
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

/** An MCP transport's reason without the wrappers the SDK and pi-mcp-adapter add around it. */
function transportless(reason: string): string {
  return (reason.split(" — ")[0] ?? reason)
    .replace(/^(?:Streamable HTTP error|SSE error|MCP error -?\d+):\s*/, "")
    .replace(/^Error POSTing to endpoint(?: \(HTTP \d+\))?:\s*/, "");
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
