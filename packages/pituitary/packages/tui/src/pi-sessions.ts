import { homedir } from "node:os";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentToText, plain } from "@pituitary/session";
import type { PickItem } from "./components/picker.tsx";
import type { SessionSummary } from "./pi-bridge.ts";
import { tilde } from "./place.ts";
import { counted } from "./plural.ts";
import { clock } from "./working.ts";

/** A prompt on the session's current branch, with what forking from it needs. */
export interface BranchPrompt {
  entryId: string;
  text: string;
  /** When the operator sent it, in milliseconds since the epoch. */
  at: number;
}

/**
 * The operator's prompts on the branch that ends at `leafId`, oldest first. Pi's own fork
 * list scans every branch in file order, so prompts are read from the entries instead.
 */
export function branchPrompts(entries: readonly SessionEntry[], leafId: string | null): BranchPrompt[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  for (let id = leafId; id !== null; ) {
    const entry = byId.get(id);
    if (!entry || branch.includes(entry)) break;
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse().flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const { message } = entry;
    return [
      {
        entryId: entry.id,
        text: contentToText(message.content),
        at: message.timestamp ?? Date.parse(entry.timestamp),
      },
    ];
  });
}

/** The first line of a prompt worth showing, terminal safe. */
export function firstLine(text: string): string {
  return (
    plain(text)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/** The fork picker's rows: the branch's prompts, newest first, each saying how far back it is. */
export function forkRows(prompts: readonly BranchPrompt[], now: number): PickItem[] {
  return prompts.toReversed().map((prompt, back) => ({
    label: firstLine(prompt.text) || "an image",
    detail: `${back === 0 ? "latest prompt" : `${counted(back, "prompt")} ago`} · ${when(prompt.at, now)}`,
    value: prompt.entryId,
  }));
}

/**
 * The resume picker's rows, the most recently changed first, each fork right under the session
 * it was forked from. `all` adds each session's project.
 */
export function sessionRows(
  sessions: readonly SessionSummary[],
  options: { current?: string; all: boolean; now: number; home?: string },
): PickItem[] {
  const { current, all, now, home = homedir() } = options;
  const recent = sessions.toSorted((a, b) => b.modified - a.modified);
  const known = new Set(recent.map((session) => session.path));
  const forks = new Map<string, SessionSummary[]>();
  for (const session of recent)
    if (session.parent && session.parent !== session.path && known.has(session.parent))
      forks.set(session.parent, [...(forks.get(session.parent) ?? []), session]);
  const rows: PickItem[] = [];
  const shown = new Set<string>();
  const visit = (session: SessionSummary, depth: number) => {
    if (shown.has(session.path)) return;
    shown.add(session.path);
    const label = sessionLabel(session);
    rows.push({
      label: depth === 0 ? label : `${"  ".repeat(depth - 1)}└ ${label}`,
      detail: [
        sessionDetail(session, now),
        ...(all && session.cwd ? [tilde(plain(session.cwd), home)] : []),
      ].join(" · "),
      value: session.path,
      current: session.path === current,
      // A renamed session is still found by what it began with.
      keywords: plain(session.first),
    });
    for (const fork of forks.get(session.path) ?? []) visit(fork, depth + 1);
  };
  for (const session of recent) if (!session.parent || !known.has(session.parent)) visit(session, 0);
  // Sessions whose parents fork from each other have no root; they still appear.
  for (const session of recent) visit(session, 0);
  return rows;
}

/** What a session is called: its name, else its first prompt's first line. */
export function sessionLabel(session: SessionSummary): string {
  return plain(session.name ?? "").trim() || firstLine(session.first) || "an empty session";
}

/** How recent and how long a session is: `5m ago · 3 prompts`. */
export function sessionDetail(session: SessionSummary, now: number): string {
  return `${ago(session.modified, now)} · ${counted(session.prompts, "prompt")}`;
}

/** How long ago `at` was, in the largest unit that fits: `just now`, `5m ago`, `3h ago`, `2d ago`, else the date. */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
  return day(at, now);
}

/** When `at` was: its time today, otherwise its date and time. */
export function when(at: number, now: number): string {
  return new Date(at).toDateString() === new Date(now).toDateString()
    ? clock(at)
    : `${day(at, now)} ${clock(at)}`;
}

function day(at: number, now: number): string {
  const date = new Date(at);
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}
