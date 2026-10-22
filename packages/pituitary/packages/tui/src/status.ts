import type { Glyph } from "./glyphs.ts";

/** What a status says about the thing it reports on, which its colour carries. */
export type Tone = "ok" | "busy" | "alarm" | "off" | "info";

/** An extension status as the footer draws it: an icon, its tone, and any words worth reading. */
export interface Badge {
  key: string;
  glyph: Glyph;
  tone: Tone;
  /** Text beside the icon, present only when the icon and colour leave something unsaid. */
  detail: string | null;
}

/**
 * State words, checked in order: a failure or a negation settles the tone before a word it
 * contains could read as ok, as `disconnected` holds `connected` and `inactive` holds `active`.
 */
const ALARM =
  /fail\w*|error\w*|✗|\bdown\b|denied|\byolo\b|disconnect|\bnot (connected|running|active)\b|unreachable|offline/i;

const TONES: readonly [RegExp, Tone][] = [
  [ALARM, "alarm"],
  [/connecting|starting|loading|pending|waiting|\bready\b|…|\.\.\./i, "busy"],
  [/inactive|disabled|\boff\b|\bidle\b|stopped|\bsaved\b/i, "off"],
  [/active|connected|running|\bok\b|\bon\b|✓|implementing|\bdone\b/i, "ok"],
];

function toneOf(text: string): Tone {
  return TONES.find(([words]) => words.test(text))?.[1] ?? "info";
}

const firstNumber = (text: string) => /\d+/.exec(text)?.[0] ?? null;

/**
 * Connected servers out of all of them, from `2/3` or `3 servers (2 connected)`: the
 * count is worth reading only while some are missing.
 */
function servers(text: string): { tone: Tone; detail: string | null } | null {
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text) ?? /(\d+) servers?.*?\((\d+) connected/.exec(text);
  if (!match) return null;
  const [up, all] = /\//.test(match[0])
    ? [Number(match[1]), Number(match[2])]
    : [Number(match[2]), Number(match[1])];
  if (up >= all) return { tone: "ok", detail: null };
  return { tone: up === 0 ? "off" : "busy", detail: `${up}/${all}` };
}

const AUTOMODE = /AM\s*([●○])\s*a:\d+\s*d:(\d+)/;

/**
 * pi-automode's `AM ● a:7 d:2`: on or off, and the actions it denied this turn while there are any.
 * Off is an alarm: tools then run unchecked.
 */
function automode(text: string, turnText: string | undefined): { tone: Tone; detail: string | null } | null {
  const match = AUTOMODE.exec(text);
  if (!match) return null;
  const [, circle, denied = "0"] = match;
  if (circle === "○") return { tone: "alarm", detail: null };
  // `d:` counts the whole session's denials, and drops below the turn's start only when reset.
  const total = Number(denied);
  const before = Number(AUTOMODE.exec(turnText ?? "")?.[2] ?? 0);
  const turn = total < before ? total : total - before;
  return turn === 0 ? { tone: "ok", detail: null } : { tone: "busy", detail: String(turn) };
}

interface Known {
  key: RegExp;
  glyph: Glyph;
  /** The words worth keeping beside the icon; none by default. */
  detail?: (text: string) => string | null;
  /**
   * A reading of the text, beside the text as the turn began, that settles the tone before the
   * state words do.
   */
  read?: (text: string, turnText: string | undefined) => { tone: Tone; detail: string | null } | null;
}

/** Statuses from extensions the operator runs, keyed by the status key each one sets. */
const KNOWN: readonly Known[] = [
  { key: /lsp/i, glyph: "lsp" },
  { key: /^mcp$/i, glyph: "mcp", read: servers },
  { key: /plan/i, glyph: "plan", detail: (text) => text.replace(/^plan\s+/i, "") },
  { key: /permission/i, glyph: "unlocked", detail: (text) => text },
  { key: /agent/i, glyph: "agents", detail: firstNumber },
  { key: /automode/i, glyph: "guard", read: automode },
];

/** Statuses that read the same in every session the operator runs, each a git repository with checkpoints. */
const QUIET = /rewind|checkpoint/i;

/**
 * The badge for one status, given its text as the current turn began; an unknown one keeps its
 * text, the only thing it says.
 */
export function badge(key: string, text: string, turnText?: string): Badge {
  const known = KNOWN.find((entry) => entry.key.test(key));
  if (!known) return { key, glyph: "status", tone: toneOf(text), detail: text };
  const read = known.read?.(text, turnText);
  // A failure outranks a count that would otherwise read as healthy, and names itself beside it.
  const failure = ALARM.exec(text)?.[0].toLowerCase();
  if (read && failure) {
    return {
      key,
      glyph: known.glyph,
      tone: "alarm",
      detail: read.detail ? `${read.detail} ${failure}` : failure,
    };
  }
  if (read) return { key, glyph: known.glyph, ...read };
  return { key, glyph: known.glyph, tone: toneOf(text), detail: known.detail?.(text) ?? null };
}

/** Every status with text worth showing, in key order, read beside its text as the current turn began. */
export function badges(
  statuses: Readonly<Record<string, string | undefined>>,
  turnStatuses: Readonly<Record<string, string | undefined>>,
): Badge[] {
  return Object.keys(statuses)
    .sort()
    .flatMap((key) => {
      const text = statuses[key]?.trim();
      return text && !QUIET.test(key) ? [badge(key, text, turnStatuses[key])] : [];
    });
}
