import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Files a list holds at most, which keeps a huge tree from stalling the editor. */
const LIMIT = 20_000;

/** How long the listing may take before it gives up. */
const TIMEOUT_MS = 1500;

/** Names with control characters in them could write to the terminal, so they are never offered. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this finds
const UNSAFE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * The files and directories under `cwd` the operator may mention, honouring .gitignore:
 * through `fd` when it is installed, through git otherwise. Names arrive NUL-separated,
 * so no name can pass itself off as two.
 */
export async function listFiles(cwd: string): Promise<string[]> {
  const run = async (command: string, args: string[]) => {
    try {
      const { stdout } = await execute(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      });
      return stdout;
    } catch {
      return null;
    }
  };
  const fd = await run("fd", [
    "--type",
    "f",
    "--type",
    "d",
    "--hidden",
    "--exclude",
    ".git",
    "--color",
    "never",
    "--print0",
    "--max-results",
    String(LIMIT),
  ]);
  const listed =
    fd ?? (await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])) ?? "";
  return listed
    .split("\0")
    .filter((name) => name && name !== "." && !UNSAFE.test(name))
    .map((name) => name.replace(/^\.\//, ""))
    .slice(0, LIMIT);
}

/** `path` as a mention: quoted when it holds a space, as pi reads it. */
export function mention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * Paths holding the letters of `query` in order, best first: a file named exactly
 * that, then a run inside the file name, then one spread across directories, with
 * shorter paths breaking ties.
 */
export function rank(query: string, paths: readonly string[], limit = 8): string[] {
  const wanted = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = scoreOf(wanted, path.toLowerCase());
    if (score !== null) scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((item) => item.path);
}

function scoreOf(query: string, path: string): number | null {
  if (!query) return 0;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  if (stem === query) return 2000;
  if (name.includes(query)) return 1000 - name.indexOf(query);
  if (path.includes(query)) return 500 - path.indexOf(query);
  let at = 0;
  let gaps = 0;
  for (const char of query) {
    const next = path.indexOf(char, at);
    if (next === -1) return null;
    gaps += next - at;
    at = next + 1;
  }
  return 100 - gaps;
}

/** The `@path` being typed where the cursor is, with where it starts and ends. */
export function mentionAt(
  text: string,
  cursor: number,
): { query: string; start: number; end: number } | null {
  const before = text.slice(0, cursor);
  const quoted = /(^|\s)@"([^"\n]*)$/.exec(before);
  if (quoted) {
    const query = quoted[2] ?? "";
    const after = /^[^"\n]*"?/.exec(text.slice(cursor))?.[0] ?? "";
    return { query, start: cursor - query.length - 2, end: cursor + after.length };
  }
  const match = /(^|\s)@([^\s@"]*)$/.exec(before);
  if (!match) return null;
  const start = cursor - (match[2]?.length ?? 0) - 1;
  const after = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? "";
  return { query: match[2] ?? "", start, end: cursor + after.length };
}
